//! Trusted-secret runtime configuration, NOT JWT signature verification.
//! The fixed upstream remains responsible for authenticating every supplied token.
use axum::http::HeaderValue;
use serde::Deserialize;
use std::{path::Path, time::{SystemTime, UNIX_EPOCH}};
use tokio::io::AsyncReadExt;

const MAX_FILE_BYTES: usize = 16 * 1024;
const MAX_TOKEN_BYTES: usize = 8192;

// Deliberately no Debug: neither parsed credentials nor headers may be logged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotFile {
    bearer_token: String,
    expires_at: u64,
    captured_at: u64,
}

pub(crate) struct TokenSnapshot {
    authorization: HeaderValue,
    token: String,
    expires_at: u64,
}

// An opaque, secret-free error: never attach an IO/JSON error or a filesystem path.
pub(crate) struct Unavailable;

impl TokenSnapshot {
    pub(crate) async fn load(path: &Path) -> Result<Self, Unavailable> {
        let file = tokio::fs::File::open(path).await.map_err(|_| Unavailable)?;
        let mut bytes = Vec::new();
        file.take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes).await.map_err(|_| Unavailable)?;
        if bytes.len() > MAX_FILE_BYTES { return Err(Unavailable); }
        let value: SnapshotFile = serde_json::from_slice(&bytes).map_err(|_| Unavailable)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| Unavailable)?.as_secs();
        let expiry_floor = now.checked_add(3).ok_or(Unavailable)?;
        if value.expires_at <= expiry_floor
            || value.captured_at.saturating_sub(now) > 30
            || now.saturating_sub(value.captured_at) > 120
            || value.expires_at.checked_sub(value.captured_at).ok_or(Unavailable)? > 300
        {
            return Err(Unavailable);
        }
        let token = value.bearer_token;
        if token.len() > MAX_TOKEN_BYTES
            || !token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        {
            return Err(Unavailable);
        }
        let mut segments = token.split('.');
        for _ in 0..3 {
            if !matches!(segments.next(), Some(segment) if !segment.is_empty()) { return Err(Unavailable); }
        }
        if segments.next().is_some() { return Err(Unavailable); }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| Unavailable)?;
        authorization.set_sensitive(true);
        Ok(Self { authorization, token, expires_at: value.expires_at })
    }

    pub(crate) fn authorization(&self) -> HeaderValue { self.authorization.clone() }
    // Only the explicitly authenticated browser bootstrap may serialize this borrowed token.
    pub(crate) fn browser_token(&self) -> &str { &self.token }
    pub(crate) fn expires_at(&self) -> u64 { self.expires_at }
    pub(crate) fn into_authorization(self) -> HeaderValue { self.authorization }
}
