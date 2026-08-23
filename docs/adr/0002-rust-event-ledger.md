# ADR 0002: Rust event ledger boundary

CTFd remains the authoritative relational system for users, teams, challenges, flags, and accepted solves. The event ledger is a derived append-only audit and replay service. It accepts versioned envelopes from a future CTFd transactional outbox, deduplicates by idempotency key, stores a payload hash, and exposes only internal authenticated ingestion and replay boundaries.

Rust is used here for a replaceable, resource-efficient service boundary. It does not make databases hot-swappable. Phase 0 supports same-engine recovery, idempotent replay, and rebuildable projections. The CTFd outbox plugin remains the next slice because its hooks must be proven against CTFd transactions.

SQLite is Phase 0 and local-only. It uses a single process writer and must run with WAL enabled in deployment, file-level backup verification, and restore drills. It is not redundant, multi-writer, or hot-swappable. The `Ledger` API is the storage boundary; a replicated same-contract backend can replace it after migration and replay tests pass.
