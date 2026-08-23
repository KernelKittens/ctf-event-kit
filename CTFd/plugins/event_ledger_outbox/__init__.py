import datetime

from sqlalchemy import event as sqlalchemy_event

from CTFd.models import Solves
from CTFd.plugins.migrations import upgrade

from .models import EventLedgerOutbox, SolveOutboxEvent

__all__ = ["EventLedgerOutbox", "SolveOutboxEvent"]


def record_solve_outbox(_mapper, connection, solve):
    account_id = solve.team_id if solve.team_id is not None else solve.user_id
    event = SolveOutboxEvent.for_solve(
        solve_id=solve.id,
        account_id=account_id,
        challenge_id=solve.challenge_id,
    )
    occurred_at = solve.date or datetime.datetime.utcnow()
    connection.execute(
        EventLedgerOutbox.__table__.insert().values(
            event_id=event.event_id,
            idempotency_key=event.idempotency_key,
            source=event.source,
            source_sequence=event.source_sequence,
            event_type=event.event_type,
            occurred_at=occurred_at,
            schema_version=event.schema_version,
            payload=event.payload,
            attempts=0,
            available_at=occurred_at,
            delivered_at=None,
            last_error=None,
        )
    )


def load(app):
    upgrade(plugin_name="event_ledger_outbox")
    if not sqlalchemy_event.contains(Solves, "after_insert", record_solve_outbox):
        sqlalchemy_event.listen(Solves, "after_insert", record_solve_outbox)
