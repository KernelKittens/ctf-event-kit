import datetime
import hashlib
import hmac
import json
import sqlite3

import pytest

from CTFd.models import Solves, db
from CTFd.plugins.event_ledger_outbox import load
from CTFd.plugins.event_ledger_outbox.dispatcher import (
    DispatchResult,
    _failure_message,
    build_request,
    dispatch_pending,
)
from CTFd.plugins.event_ledger_outbox.models import EventLedgerOutbox, SolveOutboxEvent
from tests.helpers import create_ctfd, destroy_ctfd


def test_solve_outbox_event_uses_the_solve_as_its_idempotency_key():
    event = SolveOutboxEvent.for_solve(solve_id=42, account_id=7, challenge_id=9)

    assert event.solve_id == 42
    assert event.idempotency_key == "ctfd-solve:42"


def test_solve_outbox_event_identity_and_payload_are_deterministic():
    first = SolveOutboxEvent.for_solve(solve_id=42, account_id=7, challenge_id=9)
    second = SolveOutboxEvent.for_solve(solve_id=42, account_id=7, challenge_id=9)

    assert first.event_id == second.event_id
    assert first.payload == '{"account_id":7,"challenge_id":9,"solve_id":42}'


def test_outbox_model_persists_a_canonical_solve_envelope():
    app = create_ctfd(enable_plugins=True)
    occurred_at = datetime.datetime(2026, 8, 17, 12, 0, 0)

    try:
        with app.app_context():
            event = SolveOutboxEvent.for_solve(
                solve_id=42,
                account_id=7,
                challenge_id=9,
            )
            row = EventLedgerOutbox.from_solve_event(
                event,
                occurred_at=occurred_at,
            )
            db.session.add(row)
            db.session.commit()

            saved = EventLedgerOutbox.query.one()
            assert saved.event_id == event.event_id
            assert saved.source == "ctfd"
            assert saved.source_sequence == 42
            assert saved.event_type == "solve.created"
            assert saved.schema_version == 1
            assert saved.payload == event.payload
            assert saved.occurred_at == occurred_at
            assert saved.available_at == occurred_at
            assert saved.attempts == 0
            assert saved.delivered_at is None
    finally:
        destroy_ctfd(app)


def test_pending_rows_replay_in_source_order_and_skip_future_or_delivered_rows():
    app = create_ctfd(enable_plugins=True)
    now = datetime.datetime(2026, 8, 17, 12, 0, 0)

    try:
        with app.app_context():
            for solve_id, available_at in (
                (2, now),
                (1, now),
                (3, now + datetime.timedelta(minutes=1)),
            ):
                event = SolveOutboxEvent.for_solve(
                    solve_id=solve_id,
                    account_id=7,
                    challenge_id=9,
                )
                db.session.add(
                    EventLedgerOutbox.from_solve_event(
                        event,
                        occurred_at=now,
                        available_at=available_at,
                    )
                )

            delivered = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=4,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=now,
            )
            delivered.delivered_at = now
            db.session.add(delivered)
            db.session.commit()

            pending = EventLedgerOutbox.pending(now=now, limit=10)
            assert [row.source_sequence for row in pending] == [1, 2]
    finally:
        destroy_ctfd(app)


def test_committed_solve_creates_one_outbox_row():
    from CTFd.models import Challenges, Users

    app = create_ctfd(enable_plugins=True)

    try:
        with app.app_context():
            user = Users(
                name="solver", email="solver@examplectf.com", password="password"
            )
            challenge = Challenges(
                name="challenge",
                category="test",
                description="test",
                value=100,
                type="standard",
            )
            db.session.add_all([user, challenge])
            db.session.commit()

            solve = Solves(user_id=user.id, challenge_id=challenge.id, ip="127.0.0.1")
            db.session.add(solve)
            db.session.commit()

            saved = EventLedgerOutbox.query.one()
            assert saved.source_sequence == solve.id
            assert saved.idempotency_key == f"ctfd-solve:{solve.id}"
            assert saved.payload == (
                f'{{"account_id":{user.id},"challenge_id":{challenge.id},'
                f'"solve_id":{solve.id}}}'
            )
    finally:
        destroy_ctfd(app)


def test_rolled_back_solve_leaves_no_outbox_row():
    from CTFd.models import Challenges, Users

    app = create_ctfd(enable_plugins=True)

    try:
        with app.app_context():
            user = Users(
                name="solver", email="solver@examplectf.com", password="password"
            )
            challenge = Challenges(
                name="challenge",
                category="test",
                description="test",
                value=100,
                type="standard",
            )
            db.session.add_all([user, challenge])
            db.session.commit()

            solve = Solves(user_id=user.id, challenge_id=challenge.id, ip="127.0.0.1")
            db.session.add(solve)
            db.session.flush()
            assert EventLedgerOutbox.query.count() == 1

            db.session.rollback()
            assert EventLedgerOutbox.query.count() == 0
    finally:
        destroy_ctfd(app)


def test_build_request_matches_the_rust_ledger_contract():
    app = create_ctfd()
    occurred_at = datetime.datetime(2026, 8, 17, 12, 0, 0)

    try:
        with app.app_context():
            event = SolveOutboxEvent.for_solve(
                solve_id=42,
                account_id=7,
                challenge_id=9,
            )
            row = EventLedgerOutbox.from_solve_event(
                event,
                occurred_at=occurred_at,
            )
            body, headers = build_request(row, b"secret", timestamp=1_000)

            envelope = json.loads(body)
            assert envelope == {
                "causation_id": None,
                "correlation_id": None,
                "event_id": event.event_id,
                "event_type": "solve.created",
                "idempotency_key": "ctfd-solve:42",
                "occurred_at": "2026-08-17T12:00:00Z",
                "payload": list(event.payload.encode("utf-8")),
                "schema_version": 1,
                "source": "ctfd",
                "source_sequence": 42,
            }
            expected_signature = hmac.new(
                b"secret",
                b"1000." + body,
                hashlib.sha256,
            ).hexdigest()
            assert headers == {
                "Content-Type": "application/json",
                "X-Ledger-Signature": expected_signature,
                "X-Ledger-Timestamp": "1000",
            }
    finally:
        destroy_ctfd(app)


def test_successful_dispatch_marks_one_row_delivered():
    app = create_ctfd(enable_plugins=True)
    now = datetime.datetime(2026, 8, 17, 12, 0, 0)
    calls = []

    try:
        with app.app_context():
            row = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=42,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=now,
            )
            db.session.add(row)
            db.session.commit()

            result = dispatch_pending(
                lambda endpoint, body, headers: calls.append((endpoint, body, headers)),
                secret=b"secret",
                endpoint="http://127.0.0.1:8080/v1/events",
                now=now,
            )

            assert result == DispatchResult(attempted=1, delivered=1, failed=0)
            assert len(calls) == 1
            saved = EventLedgerOutbox.query.one()
            assert saved.delivered_at == now
            assert saved.attempts == 0
            assert saved.last_error is None
    finally:
        destroy_ctfd(app)


def test_failed_dispatch_records_bounded_error_and_schedules_retry():
    app = create_ctfd(enable_plugins=True)
    now = datetime.datetime(2026, 8, 17, 12, 0, 0)

    def fail(_endpoint, _body, _headers):
        raise RuntimeError(
            "https://operator:hunter2@ledger.test/events?token=secret\x00\x1b[31m"
        )

    try:
        with app.app_context():
            row = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=42,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=now,
            )
            db.session.add(row)
            db.session.commit()

            result = dispatch_pending(
                fail,
                secret=b"secret",
                endpoint="http://127.0.0.1:8080/v1/events",
                now=now,
            )

            assert result == DispatchResult(attempted=1, delivered=0, failed=1)
            saved = EventLedgerOutbox.query.one()
            assert saved.attempts == 1
            assert saved.delivered_at is None
            assert saved.last_error == "RuntimeError"
            assert len(saved.last_error) <= 512
            assert saved.available_at == now + datetime.timedelta(seconds=1)

            result = dispatch_pending(
                fail,
                secret=b"secret",
                endpoint="http://127.0.0.1:8080/v1/events",
                now=now,
            )

            assert result == DispatchResult(attempted=0, delivered=0, failed=0)
            assert EventLedgerOutbox.query.one().attempts == 1
    finally:
        destroy_ctfd(app)


@pytest.mark.parametrize("limit", [0, -1, True, 1.5])
def test_dispatch_rejects_non_positive_or_non_integer_limits(monkeypatch, limit):
    monkeypatch.setattr(
        EventLedgerOutbox,
        "pending",
        classmethod(lambda _cls, now, limit: []),
    )

    with pytest.raises(ValueError):
        dispatch_pending(
            lambda _endpoint, _body, _headers: None,
            secret=b"secret",
            endpoint="http://127.0.0.1:8080/v1/events",
            now=datetime.datetime(2026, 8, 17, 12, 0, 0),
            limit=limit,
        )


def test_dispatch_clamps_oversized_limits(monkeypatch):
    limits = []
    monkeypatch.setattr(
        EventLedgerOutbox,
        "pending",
        classmethod(lambda _cls, now, limit: limits.append(limit) or []),
    )

    result = dispatch_pending(
        lambda _endpoint, _body, _headers: None,
        secret=b"secret",
        endpoint="http://127.0.0.1:8080/v1/events",
        now=datetime.datetime(2026, 8, 17, 12, 0, 0),
        limit=1_000,
    )

    assert result == DispatchResult(attempted=0, delivered=0, failed=0)
    assert limits == [100]


def test_dispatch_normalizes_aware_now_for_database_and_hmac():
    app = create_ctfd(enable_plugins=True)
    central_daylight_time = datetime.timezone(datetime.timedelta(hours=-5))
    now = datetime.datetime(2026, 8, 17, 12, 0, 0, tzinfo=central_daylight_time)
    utc_now = datetime.datetime(2026, 8, 17, 17, 0, 0)
    headers_seen = []

    try:
        with app.app_context():
            row = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=42,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=utc_now,
            )
            db.session.add(row)
            db.session.commit()

            result = dispatch_pending(
                lambda _endpoint, _body, headers: headers_seen.append(headers),
                secret=b"secret",
                endpoint="http://127.0.0.1:8080/v1/events",
                now=now,
            )

            assert result == DispatchResult(attempted=1, delivered=1, failed=0)
            assert headers_seen[0]["X-Ledger-Timestamp"] == str(int(now.timestamp()))
            assert EventLedgerOutbox.query.one().delivered_at == utc_now
    finally:
        destroy_ctfd(app)


def test_failure_message_bounds_long_http_error_types():
    long_http_error = type("X" * 600, (Exception,), {"code": 500})

    message = _failure_message(long_http_error())

    assert len(message) == 512
    assert message.endswith(": HTTP 500")


def test_replayed_request_bytes_are_deterministic():
    app = create_ctfd()
    occurred_at = datetime.datetime(2026, 8, 17, 12, 0, 0)

    try:
        with app.app_context():
            row = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=42,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=occurred_at,
            )

            first = build_request(row, b"secret", timestamp=1_000)
            second = build_request(row, b"secret", timestamp=1_000)

            assert first == second
    finally:
        destroy_ctfd(app)


def test_process_exit_leaves_row_pending_for_identical_replay():
    app = create_ctfd(enable_plugins=True)
    now = datetime.datetime(2026, 8, 17, 12, 0, 0)
    calls = []

    def crash(_endpoint, body, _headers):
        calls.append(body)
        raise SystemExit(1)

    try:
        with app.app_context():
            row = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=42,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=now,
            )
            db.session.add(row)
            db.session.commit()

            with pytest.raises(SystemExit):
                dispatch_pending(
                    crash,
                    secret=b"secret",
                    endpoint="http://127.0.0.1:8080/v1/events",
                    now=now,
                )

            saved = EventLedgerOutbox.query.one()
            assert saved.delivered_at is None
            assert saved.attempts == 0

            result = dispatch_pending(
                lambda _endpoint, body, _headers: calls.append(body),
                secret=b"secret",
                endpoint="http://127.0.0.1:8080/v1/events",
                now=now,
            )

            assert result == DispatchResult(attempted=1, delivered=1, failed=0)
            assert calls[0] == calls[1]
    finally:
        destroy_ctfd(app)


def test_repeated_plugin_loading_does_not_duplicate_solve_events():
    from CTFd.models import Challenges, Users

    app = create_ctfd(enable_plugins=True)

    try:
        with app.app_context():
            load(app)
            load(app)
            user = Users(
                name="solver", email="solver@examplectf.com", password="password"
            )
            challenge = Challenges(
                name="challenge",
                category="test",
                description="test",
                value=100,
                type="standard",
            )
            db.session.add_all([user, challenge])
            db.session.commit()

            solve = Solves(user_id=user.id, challenge_id=challenge.id, ip="127.0.0.1")
            db.session.add(solve)
            db.session.commit()

            assert EventLedgerOutbox.query.count() == 1
    finally:
        destroy_ctfd(app)


def test_sqlite_backup_retains_pending_outbox_rows(tmp_path):
    app = create_ctfd(enable_plugins=True)
    now = datetime.datetime(2026, 8, 17, 12, 0, 0)
    backup_path = tmp_path / "ctfd-backup.sqlite"

    try:
        with app.app_context():
            if db.engine.dialect.name != "sqlite":
                pytest.skip("uses SQLite's native backup API")

            row = EventLedgerOutbox.from_solve_event(
                SolveOutboxEvent.for_solve(
                    solve_id=42,
                    account_id=7,
                    challenge_id=9,
                ),
                occurred_at=now,
            )
            db.session.add(row)
            db.session.commit()

            source = db.session.connection().connection.driver_connection
            with sqlite3.connect(backup_path) as backup:
                source.backup(backup)

        with sqlite3.connect(backup_path) as restored:
            saved = restored.execute(
                "SELECT idempotency_key, attempts, delivered_at "
                "FROM event_ledger_outbox"
            ).fetchone()

        assert saved == ("ctfd-solve:42", 0, None)
    finally:
        destroy_ctfd(app)
