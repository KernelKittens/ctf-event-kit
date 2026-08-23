import datetime
import json
import uuid
from dataclasses import dataclass

from CTFd.models import db


@dataclass(frozen=True)
class SolveOutboxEvent:
    solve_id: int
    account_id: int
    challenge_id: int
    event_id: str
    idempotency_key: str
    source: str
    source_sequence: int
    event_type: str
    schema_version: int
    payload: str

    @classmethod
    def for_solve(
        cls,
        *,
        solve_id: int,
        account_id: int,
        challenge_id: int,
    ) -> "SolveOutboxEvent":
        idempotency_key = f"ctfd-solve:{solve_id}"
        return cls(
            solve_id=solve_id,
            account_id=account_id,
            challenge_id=challenge_id,
            event_id=str(uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key)),
            idempotency_key=idempotency_key,
            source="ctfd",
            source_sequence=solve_id,
            event_type="solve.created",
            schema_version=1,
            payload=json.dumps(
                {
                    "account_id": account_id,
                    "challenge_id": challenge_id,
                    "solve_id": solve_id,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        )


class EventLedgerOutbox(db.Model):
    __tablename__ = "event_ledger_outbox"
    __table_args__ = (
        db.Index(
            "ix_event_ledger_outbox_pending",
            "delivered_at",
            "available_at",
            "source_sequence",
        ),
    )

    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.String(36), nullable=False, unique=True)
    idempotency_key = db.Column(db.String(128), nullable=False, unique=True)
    source = db.Column(db.String(32), nullable=False)
    source_sequence = db.Column(db.Integer, nullable=False)
    event_type = db.Column(db.String(64), nullable=False)
    occurred_at = db.Column(db.DateTime, nullable=False)
    schema_version = db.Column(db.Integer, nullable=False, default=1)
    payload = db.Column(db.Text, nullable=False)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    available_at = db.Column(db.DateTime, nullable=False)
    delivered_at = db.Column(db.DateTime)
    last_error = db.Column(db.Text)

    @classmethod
    def from_solve_event(
        cls,
        event: SolveOutboxEvent,
        *,
        occurred_at: datetime.datetime = None,
        available_at: datetime.datetime = None,
    ) -> "EventLedgerOutbox":
        occurred_at = occurred_at or datetime.datetime.utcnow()
        return cls(
            event_id=event.event_id,
            idempotency_key=event.idempotency_key,
            source=event.source,
            source_sequence=event.source_sequence,
            event_type=event.event_type,
            occurred_at=occurred_at,
            schema_version=event.schema_version,
            payload=event.payload,
            attempts=0,
            available_at=available_at or occurred_at,
        )

    @classmethod
    def pending(cls, now: datetime.datetime, limit: int):
        return (
            cls.query.filter(
                cls.delivered_at.is_(None),
                cls.available_at <= now,
            )
            .order_by(cls.source_sequence.asc(), cls.id.asc())
            .limit(limit)
            .all()
        )
