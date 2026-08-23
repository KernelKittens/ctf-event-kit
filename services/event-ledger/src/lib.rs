use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub event_id: Uuid,
    pub idempotency_key: String,
    pub source: String,
    pub source_sequence: i64,
    pub event_type: String,
    pub occurred_at: DateTime<Utc>,
    pub schema_version: u16,
    pub correlation_id: Option<Uuid>,
    pub causation_id: Option<Uuid>,
    pub payload: Vec<u8>,
}

impl EventEnvelope {
    pub fn new(
        key: &str,
        source: &str,
        source_sequence: i64,
        event_type: &str,
        payload: Vec<u8>,
    ) -> Self {
        Self {
            event_id: Uuid::new_v4(),
            idempotency_key: key.into(),
            source: source.into(),
            source_sequence,
            event_type: event_type.into(),
            occurred_at: Utc::now(),
            schema_version: 1,
            correlation_id: None,
            causation_id: None,
            payload,
        }
    }

    pub fn validate(&self) -> Result<(), LedgerError> {
        if self.idempotency_key.is_empty()
            || self.idempotency_key.len() > 128
            || self.source.is_empty()
            || self.event_type.is_empty()
            || self.source_sequence < 0
            || self.payload.len() > 65_536
            || self.schema_version == 0
        {
            return Err(LedgerError::InvalidEnvelope);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedEvent {
    pub sequence: i64,
    pub event_id: Uuid,
}

#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("invalid event envelope")]
    InvalidEnvelope,
    #[error("idempotency key was reused with different content")]
    IdempotencyConflict,
    #[error("storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("stored UUID is invalid")]
    InvalidStoredUuid,
}

pub struct Ledger {
    connection: Mutex<Connection>,
}

impl Ledger {
    pub fn in_memory() -> Result<Self, LedgerError> {
        let ledger = Self {
            connection: Mutex::new(Connection::open_in_memory()?),
        };
        ledger.migrate()?;
        Ok(ledger)
    }
    pub fn open(path: &str) -> Result<Self, LedgerError> {
        let ledger = Self {
            connection: Mutex::new(Connection::open(path)?),
        };
        ledger.migrate()?;
        Ok(ledger)
    }
    pub fn ready(&self) -> Result<(), LedgerError> {
        self.connection
            .lock()
            .unwrap()
            .query_row("SELECT 1", [], |_| Ok(()))
            .map_err(LedgerError::from)
    }
    fn migrate(&self) -> Result<(), LedgerError> {
        self.connection.lock().unwrap().execute_batch("CREATE TABLE IF NOT EXISTS ledger_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL, source TEXT NOT NULL, source_sequence INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, schema_version INTEGER NOT NULL, payload BLOB NOT NULL, payload_hash BLOB NOT NULL); ")?;
        Ok(())
    }
    pub fn append(&self, event: EventEnvelope) -> Result<PersistedEvent, LedgerError> {
        event.validate()?;
        let hash = Sha256::digest(&event.payload).to_vec();
        let connection = self.connection.lock().unwrap();
        let existing: Option<(i64, String, Vec<u8>)> = connection.query_row("SELECT sequence, event_id, payload_hash FROM ledger_events WHERE idempotency_key = ?1", [&event.idempotency_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        if let Some((sequence, id, old_hash)) = existing {
            if old_hash == hash {
                return Ok(PersistedEvent {
                    sequence,
                    event_id: Uuid::parse_str(&id).map_err(|_| LedgerError::InvalidStoredUuid)?,
                });
            }
            return Err(LedgerError::IdempotencyConflict);
        }
        connection.execute("INSERT INTO ledger_events (idempotency_key,event_id,source,source_sequence,event_type,occurred_at,schema_version,payload,payload_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![event.idempotency_key, event.event_id.to_string(), event.source, event.source_sequence, event.event_type, event.occurred_at.to_rfc3339(), event.schema_version, event.payload, hash])?;
        Ok(PersistedEvent {
            sequence: connection.last_insert_rowid(),
            event_id: event.event_id,
        })
    }
    pub fn replay_after(&self, sequence: i64) -> Result<Vec<PersistedEvent>, LedgerError> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT sequence,event_id FROM ledger_events WHERE sequence > ?1 ORDER BY sequence ASC",
        )?;
        statement
            .query_map([sequence], |row| {
                Ok(PersistedEvent {
                    sequence: row.get(0)?,
                    event_id: Uuid::parse_str(&row.get::<_, String>(1)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(LedgerError::from)
    }
}

pub fn sign_request(secret: &[u8], timestamp: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn verify_request(
    secret: &[u8],
    timestamp: i64,
    body: &[u8],
    supplied_hex: &str,
    now: i64,
    window_seconds: i64,
) -> bool {
    if window_seconds < 0
        || now.saturating_sub(timestamp).abs() > window_seconds
        || supplied_hex.len() != 64
    {
        return false;
    }
    let expected = sign_request(secret, timestamp, body);
    expected.as_bytes().ct_eq(supplied_hex.as_bytes()).into()
}
