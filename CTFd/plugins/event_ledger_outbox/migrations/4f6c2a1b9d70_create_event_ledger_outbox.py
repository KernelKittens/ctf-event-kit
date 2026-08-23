"""Create the event ledger outbox table.

Revision ID: 4f6c2a1b9d70
Revises:
Create Date: 2026-08-17
"""

import sqlalchemy as sa

revision = "4f6c2a1b9d70"
down_revision = None
branch_labels = None
depends_on = None


def upgrade(op=None):
    op.create_table(
        "event_ledger_outbox",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(length=36), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("source_sequence", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    op.create_index(
        "ix_event_ledger_outbox_pending",
        "event_ledger_outbox",
        ["delivered_at", "available_at", "source_sequence"],
        unique=False,
    )


def downgrade(op=None):
    op.drop_index(
        "ix_event_ledger_outbox_pending",
        table_name="event_ledger_outbox",
    )
    op.drop_table("event_ledger_outbox")
