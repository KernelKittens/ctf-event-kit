use event_ledger::{EventEnvelope, Ledger, LedgerError};

fn envelope(key: &str, payload: &str) -> EventEnvelope {
    EventEnvelope::new(
        key,
        "ctfd",
        42,
        "solve.created",
        payload.as_bytes().to_vec(),
    )
}

#[test]
fn rejects_invalid_envelope() {
    assert!(
        EventEnvelope::new("", "ctfd", 1, "solve.created", vec![])
            .validate()
            .is_err()
    );
}

#[test]
fn duplicate_returns_original_and_conflicting_key_is_rejected() {
    let ledger = Ledger::in_memory().unwrap();
    let first = ledger.append(envelope("k-1", "one")).unwrap();
    let duplicate = ledger.append(envelope("k-1", "one")).unwrap();
    assert_eq!(first, duplicate);
    assert!(matches!(
        ledger.append(envelope("k-1", "two")),
        Err(LedgerError::IdempotencyConflict)
    ));
}

#[test]
fn replay_is_deterministic_and_persistent() {
    let ledger = Ledger::in_memory().unwrap();
    ledger.append(envelope("k-1", "one")).unwrap();
    ledger.append(envelope("k-2", "two")).unwrap();
    let events = ledger.replay_after(0).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[test]
fn accepts_current_hmac_and_rejects_stale_or_modified_request() {
    let body = b"event";
    let signature = event_ledger::sign_request(b"secret", 1_000, body);
    assert!(event_ledger::verify_request(
        b"secret", 1_000, body, &signature, 1_030, 60
    ));
    assert!(!event_ledger::verify_request(
        b"secret", 1_000, b"other", &signature, 1_030, 60
    ));
    assert!(!event_ledger::verify_request(
        b"secret", 1_000, body, &signature, 1_061, 60
    ));
}

#[test]
fn persisted_events_survive_a_database_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ledger.db");
    {
        let ledger = Ledger::open(path.to_str().unwrap()).unwrap();
        ledger.append(envelope("restart-1", "one")).unwrap();
    }
    let reopened = Ledger::open(path.to_str().unwrap()).unwrap();
    assert_eq!(reopened.replay_after(0).unwrap().len(), 1);
}
