use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use event_ledger::{EventEnvelope, Ledger, LedgerError, verify_request};
use serde_json::json;
use std::{env, sync::Arc};

#[derive(Clone)]
struct AppState {
    ledger: Arc<Ledger>,
    secret: Arc<[u8]>,
}

#[tokio::main]
async fn main() {
    let database = env::var("EVENT_LEDGER_DATABASE").unwrap_or_else(|_| "event-ledger.db".into());
    let secret =
        env::var("EVENT_LEDGER_HMAC_SECRET").expect("EVENT_LEDGER_HMAC_SECRET is required");
    let state = AppState {
        ledger: Arc::new(Ledger::open(&database).expect("database migration failed")),
        secret: secret.into_bytes().into(),
    };
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/v1/events", post(ingest))
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080")
        .await
        .expect("bind failed");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("server failed");
}
async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}
async fn ready(State(state): State<AppState>) -> StatusCode {
    if state.ledger.ready().is_ok() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}
async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let timestamp = headers
        .get("x-ledger-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let signature = headers
        .get("x-ledger-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let now = chrono::Utc::now().timestamp();
    if !verify_request(&state.secret, timestamp, &body, signature, now, 60) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let event: EventEnvelope =
        serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    match state.ledger.append(event) {
        Ok(saved) => Ok(Json(
            json!({"sequence": saved.sequence, "event_id": saved.event_id}),
        )),
        Err(LedgerError::IdempotencyConflict) => Err(StatusCode::CONFLICT),
        Err(LedgerError::InvalidEnvelope) => Err(StatusCode::BAD_REQUEST),
        Err(_) => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}
