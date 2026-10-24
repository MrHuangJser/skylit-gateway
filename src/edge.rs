//! Ephemeral fixed-origin grants. Deliberately no Debug, serialization or persistence.
use axum::http::{header, HeaderMap, HeaderValue};
use std::time::{Duration, Instant};

pub(crate) const MAX_TTL: u64 = 14_400;
const NAMES: [&str; 3] = ["CloudFront-Key-Pair-Id", "CloudFront-Policy", "CloudFront-Signature"];
pub(crate) struct Unavailable;
pub(crate) struct CookieLease {
    pub(crate) owner: String,
    pub(crate) expires: Instant,
    cookie: HeaderValue,
    ttl_seconds: u64,
}

impl CookieLease {
    pub(crate) fn parse(headers: &HeaderMap, owner: String, body_ttl: u64, started: Instant) -> Result<Self, Unavailable> {
        if owner.trim().is_empty() || !(1..=MAX_TTL).contains(&body_ttl) { return Err(Unavailable); }
        let mut values: [Option<String>; 3] = [None, None, None];
        let mut ttl = body_ttl;
        for raw in headers.get_all(header::SET_COOKIE) {
            let raw = raw.to_str().map_err(|_| Unavailable)?;
            // Reject controls everywhere, including tabs in attributes and non-ASCII.
            if !raw.bytes().all(|b| (0x20..=0x7e).contains(&b)) { return Err(Unavailable); }
            let mut parts = raw.split(';');
            let (name, value) = parts.next().ok_or(Unavailable)?.split_once('=').ok_or(Unavailable)?;
            let index = NAMES.iter().position(|n| *n == name).ok_or(Unavailable)?;
            if values[index].is_some() || value.is_empty()
                || !value.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b';' && b != b',')
            { return Err(Unavailable); }
            let (mut path, mut age, mut secure, mut http_only, mut domain) = (false, None, false, false, false);
            for part in parts {
                let part = part.trim();
                let (key, value) = match part.split_once('=') { Some((k,v)) => (k, Some(v)), None => (part, None) };
                if key.eq_ignore_ascii_case("Path") {
                    if path || value != Some("/api/data") { return Err(Unavailable); }
                    path = true;
                } else if key.eq_ignore_ascii_case("Max-Age") {
                    let value = value.ok_or(Unavailable)?;
                    if age.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) { return Err(Unavailable); }
                    let seconds = value.parse::<u64>().map_err(|_| Unavailable)?;
                    if !(1..=MAX_TTL).contains(&seconds) { return Err(Unavailable); }
                    age = Some(seconds);
                } else if key.eq_ignore_ascii_case("Secure") {
                    if secure || value.is_some() { return Err(Unavailable); }
                    secure = true;
                } else if key.eq_ignore_ascii_case("HttpOnly") {
                    if http_only || value.is_some() { return Err(Unavailable); }
                    http_only = true;
                } else if key.eq_ignore_ascii_case("Domain") {
                    if domain || !value.is_some_and(|v| v.eq_ignore_ascii_case("app.skylit.ai") || v.eq_ignore_ascii_case(".skylit.ai")) { return Err(Unavailable); }
                    domain = true;
                } else if key.eq_ignore_ascii_case("SameSite") {
                    if value != Some("Lax") { return Err(Unavailable); }
                } else { return Err(Unavailable); }
            }
            if !path || !secure || !http_only { return Err(Unavailable); }
            ttl = ttl.min(age.ok_or(Unavailable)?);
            values[index] = Some(value.to_owned());
        }
        let mut pairs = Vec::new();
        for (name, value) in NAMES.iter().zip(values) {
            pairs.push(format!("{name}={}", value.ok_or(Unavailable)?));
        }
        let mut cookie = HeaderValue::from_str(&pairs.join("; ")).map_err(|_| Unavailable)?;
        cookie.set_sensitive(true);
        let expires = started.checked_add(Duration::from_secs(ttl)).ok_or(Unavailable)?;
        if expires <= Instant::now() { return Err(Unavailable); }
        Ok(Self { owner, expires, cookie, ttl_seconds: ttl })
    }
    pub(crate) fn cookie(&self) -> Option<HeaderValue> {
        (self.expires > Instant::now()).then(|| self.cookie.clone())
    }
    pub(crate) fn ttl_seconds(&self) -> u64 { self.ttl_seconds }
}

pub(crate) fn is_data_path(path: &str) -> bool { matches!(path, "/api/data" | "/api/data/range") }
