import datetime
import hashlib
import hmac
import json
import re
from dataclasses import dataclass

from CTFd.models import db

from .models import EventLedgerOutbox

MAX_ERROR_LENGTH = 512
MAX_DISPATCH_LIMIT = 100
MAX_RETRY_DELAY_SECONDS = 300


@dataclass(frozen=True)
class DispatchResult:
    attempted: int
    delivered: int
    failed: int


def build_request(row, secret: bytes, timestamp: int):
    occurred_at = row.occurred_at
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=datetime.timezone.utc)
    envelope = {
        "causation_id": None,
        "correlation_id": None,
        "event_id": row.event_id,
        "event_type": row.event_type,
        "idempotency_key": row.idempotency_key,
        "occurred_at": occurred_at.isoformat().replace("+00:00", "Z"),
        "payload": list(row.payload.encode("utf-8")),
        "schema_version": row.schema_version,
        "source": row.source,
        "source_sequence": row.source_sequence,
    }
    body = json.dumps(
        envelope,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    signature = hmac.new(
        secret,
        str(timestamp).encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return body, {
        "Content-Type": "application/json",
        "X-Ledger-Signature": signature,
        "X-Ledger-Timestamp": str(timestamp),
    }


def _failure_message(error: Exception) -> str:
    error_type = re.sub(r"[^A-Za-z0-9_.]", "", type(error).__name__)
    error_type = error_type or "Exception"
    status_code = getattr(error, "code", None)
    if (
        isinstance(status_code, int)
        and not isinstance(status_code, bool)
        and 100 <= status_code <= 599
    ):
        suffix = f": HTTP {status_code}"
        return f"{error_type[: MAX_ERROR_LENGTH - len(suffix)]}{suffix}"
    return error_type[:MAX_ERROR_LENGTH]


def _retry_delay(attempts: int) -> datetime.timedelta:
    delay_seconds = min(MAX_RETRY_DELAY_SECONDS, 2 ** min(attempts - 1, 9))
    return datetime.timedelta(seconds=delay_seconds)


def _bounded_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        raise ValueError("limit must be a positive integer")
    return min(limit, MAX_DISPATCH_LIMIT)


def _utc_naive(value: datetime.datetime) -> datetime.datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(datetime.timezone.utc).replace(tzinfo=None)


def _unix_timestamp(value: datetime.datetime) -> int:
    utc_value = _utc_naive(value).replace(tzinfo=datetime.timezone.utc)
    return int(utc_value.timestamp())


def dispatch_pending(send, secret, endpoint, now, limit=100):
    attempted = 0
    delivered = 0
    failed = 0
    now = _utc_naive(now)
    timestamp = _unix_timestamp(now)
    limit = _bounded_limit(limit)
    for row in EventLedgerOutbox.pending(now=now, limit=limit):
        attempted += 1
        body, headers = build_request(
            row,
            secret,
            timestamp=timestamp,
        )
        try:
            send(endpoint, body, headers)
        except Exception as error:
            row.attempts += 1
            row.available_at = now + _retry_delay(row.attempts)
            row.last_error = _failure_message(error)
            db.session.commit()
            failed += 1
        else:
            row.delivered_at = now
            row.last_error = None
            db.session.commit()
            delivered += 1
    return DispatchResult(
        attempted=attempted,
        delivered=delivered,
        failed=failed,
    )
