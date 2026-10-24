//! Per-device, proxy-local storage of user UI state (layouts, drawings, presets,
//! watchlists, favorites, preferences). These requests never reach the upstream.
//! Shapes follow the observed original-frontend contracts in
//! docs/device-state-endpoints.md; the frontend rejects malformed replies.
use axum::{
    body::Body,
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

pub(crate) const MAX_BODY: usize = 1024 * 1024;
const MAX_DEVICE_FILE: usize = 4 * 1024 * 1024;

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub(crate) struct DeviceState {
    layouts: Vec<Value>,
    layouts_updated: i64,
    drawings: Map<String, Value>,
    drawings_updated: Map<String, Value>,
    presets: Option<Value>,
    watchlist_order: Option<Value>,
    watchlists: Vec<Value>,
    favorites: Vec<String>,
    siren_preferences: Option<Value>,
    talon_preferences: Option<Value>,
}

pub(crate) struct Store {
    dir: Option<PathBuf>,
    devices: Mutex<HashMap<String, DeviceState>>,
}

/// The routes owned by the device store. Matching is exact-segment.
pub(crate) fn owns(path: &str) -> bool {
    matches!(path, "/tv/layouts" | "/tv/drawings" | "/tv/presets" | "/tv/watchlist-order"
        | "/api/watchlists" | "/api/favorites" | "/siren/preferences"
        | "/agent-gateway/platform/api/v1/talon/preferences")
        || single_segment(path, "/tv/layouts/").is_some()
        || single_segment(path, "/tv/drawings/").is_some()
        || single_segment(path, "/api/watchlists/").is_some()
        || single_segment(path, "/api/favorites/").is_some()
}

fn single_segment<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix(prefix)?;
    (!rest.is_empty() && !rest.contains('/')).then_some(rest)
}

fn decode(segment: &str) -> Option<String> {
    let decoded = percent_decode(segment)?;
    (!decoded.is_empty() && decoded.len() <= 200 && !decoded.chars().any(char::is_control)).then_some(decoded)
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = input.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else { out.push(bytes[i]); i += 1; }
    }
    String::from_utf8(out).ok()
}

fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty() && symbol.len() <= 64
        && symbol.bytes().all(|b| b.is_ascii_alphanumeric() || b".:_/^-".contains(&b))
}

pub(crate) fn valid_device_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn now_iso() -> String {
    let secs = now_ms() / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn reply(status: StatusCode, value: Value) -> Response {
    crate::local((status, Json(value)).into_response())
}
fn empty(status: StatusCode) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = status;
    crate::local(response)
}
fn bad(message: &'static str) -> Response { reply(StatusCode::BAD_REQUEST, json!({"error": message})) }

impl Store {
    pub(crate) fn new(dir: Option<PathBuf>) -> Self { Self { dir, devices: Mutex::new(HashMap::new()) } }

    fn file(&self, device: &str) -> Option<PathBuf> {
        let dir = self.dir.as_ref()?;
        if !valid_device_id(device) { return None; }
        let path = dir.join(format!("{device}.json"));
        (path.parent() == Some(dir.as_path())).then_some(path)
    }

    fn load(&self, device: &str) -> DeviceState {
        let Some(path) = self.file(device) else { return DeviceState::default() };
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() as usize <= MAX_DEVICE_FILE => std::fs::read(&path).ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default(),
            _ => DeviceState::default(),
        }
    }

    fn persist(&self, device: &str, state: &DeviceState) -> Result<(), ()> {
        let Some(path) = self.file(device) else { return if self.dir.is_some() { Err(()) } else { Ok(()) } };
        let bytes = serde_json::to_vec(state).map_err(|_| ())?;
        if bytes.len() > MAX_DEVICE_FILE { return Err(()); }
        let mut suffix = [0u8; 8];
        OsRng.fill_bytes(&mut suffix);
        let temp = path.with_file_name(format!("{device}.{}.tmp", hex::encode(suffix)));
        if temp.parent() != path.parent() { return Err(()); }
        std::fs::write(&temp, &bytes).map_err(|_| ())?;
        std::fs::rename(&temp, &path).map_err(|_| { let _ = std::fs::remove_file(&temp); })
    }

    /// Runs `f` against this device's state, persisting when it reports a change.
    fn with<R>(&self, device: &str, f: impl FnOnce(&mut DeviceState) -> (R, bool)) -> Result<R, ()> {
        let mut devices = self.devices.lock().map_err(|_| ())?;
        if !devices.contains_key(device) {
            let loaded = self.load(device);
            devices.insert(device.to_owned(), loaded);
        }
        let state = devices.get_mut(device).ok_or(())?;
        let snapshot = state.clone();
        let (result, changed) = f(state);
        if changed && self.persist(device, state).is_err() {
            *state = snapshot; // Never acknowledge a write that was not stored.
            return Err(());
        }
        Ok(result)
    }

    pub(crate) fn handle(&self, device: &str, method: &Method, path: &str,
        if_none_match: Option<&str>, body: &[u8]) -> Response {
        let parsed = if body.is_empty() { None } else {
            match serde_json::from_slice::<Value>(body) { Ok(v) => Some(v), Err(_) => return bad("Invalid request JSON") }
        };
        let outcome = self.route(device, method, path, if_none_match, parsed);
        outcome.unwrap_or_else(|_| reply(StatusCode::SERVICE_UNAVAILABLE, json!({"error":"Device state unavailable"})))
    }

    fn route(&self, device: &str, method: &Method, path: &str, if_none_match: Option<&str>,
        body: Option<Value>) -> Result<Response, ()> {
        let get = method == Method::GET || method == Method::HEAD;
        match path {
            "/tv/layouts" if get => self.with(device, |s| {
                let etag = format!("W/\"{}-{}\"", s.layouts_updated, s.layouts.len());
                if if_none_match == Some(etag.as_str()) { return (empty(StatusCode::NOT_MODIFIED), false); }
                let mut response = reply(StatusCode::OK, json!({"layouts": s.layouts, "updatedAt": s.layouts_updated}));
                if let Ok(v) = HeaderValue::from_str(&etag) { response.headers_mut().insert(header::ETAG, v); }
                (response, false)
            }),
            "/tv/drawings" if get => self.with(device, |s| {
                let updated = s.drawings_updated.values().filter_map(Value::as_i64).max().unwrap_or(0);
                (reply(StatusCode::OK, json!({"drawings": s.drawings, "updatedAt": updated})), false)
            }),
            "/tv/presets" => {
                if get { return self.with(device, |s| (reply(StatusCode::OK, s.presets.clone()
                    .unwrap_or_else(|| json!({"presets": [], "activeByTool": {}, "updatedAt": 0}))), false)); }
                if *method != Method::PUT { return Ok(method_not_allowed()); }
                let Some(Value::Object(b)) = body else { return Ok(bad("Object body required")) };
                let value = json!({"presets": b.get("presets").cloned().unwrap_or(json!([])),
                    "activeByTool": b.get("activeByTool").cloned().unwrap_or(json!({})), "updatedAt": now_ms()});
                self.with(device, |s| { s.presets = Some(value.clone()); (reply(StatusCode::OK, value), true) })
            }
            "/tv/watchlist-order" => {
                if get { return self.with(device, |s| (reply(StatusCode::OK, s.watchlist_order.clone()
                    .unwrap_or_else(|| json!({"sectionOrder": [], "symbolOrder": {}, "updatedAt": 0}))), false)); }
                if *method != Method::PUT { return Ok(method_not_allowed()); }
                let Some(Value::Object(mut b)) = body else { return Ok(bad("Object body required")) };
                b.insert("updatedAt".into(), json!(now_ms()));
                let value = Value::Object(b);
                self.with(device, |s| { s.watchlist_order = Some(value.clone()); (reply(StatusCode::OK, value), true) })
            }
            "/api/watchlists" => {
                if get { return self.with(device, |s| (reply(StatusCode::OK, json!({"user_id": "device",
                    "watchlists": s.watchlists, "favorites": s.favorites, "updated_at": now_iso()})), false)); }
                if *method != Method::POST { return Ok(method_not_allowed()); }
                let Some(Value::Object(mut b)) = body else { return Ok(bad("Object body required")) };
                if !b.get("name").is_some_and(Value::is_string) { return Ok(bad("Watchlist name required")); }
                let mut id = [0u8; 8];
                OsRng.fill_bytes(&mut id);
                let stamp = now_iso();
                b.insert("id".into(), json!(format!("wl_{}", hex::encode(id))));
                b.entry("symbols").or_insert(json!([]));
                b.entry("is_default").or_insert(json!(false));
                b.insert("created_at".into(), json!(stamp));
                b.insert("updated_at".into(), json!(stamp));
                let item = Value::Object(b);
                self.with(device, |s| { s.watchlists.push(item.clone()); (reply(StatusCode::OK, json!({"watchlist": item})), true) })
            }
            "/api/favorites" if get => self.with(device, |s| (reply(StatusCode::OK, json!({"favorites": s.favorites})), false)),
            "/siren/preferences" => {
                if get { return self.with(device, |s| (reply(StatusCode::OK, s.siren_preferences.clone().unwrap_or(json!({}))), false)); }
                if *method != Method::PUT { return Ok(method_not_allowed()); }
                let Some(value @ Value::Object(_)) = body else { return Ok(bad("Object body required")) };
                self.with(device, |s| { s.siren_preferences = Some(value.clone()); (reply(StatusCode::OK, value), true) })
            }
            "/agent-gateway/platform/api/v1/talon/preferences" => {
                if get { return self.with(device, |s| (reply(StatusCode::OK,
                    json!({"prefs_json": s.talon_preferences.clone().unwrap_or(json!({}))})), false)); }
                if *method != Method::PUT { return Ok(method_not_allowed()); }
                let Some(Value::Object(b)) = body else { return Ok(bad("Object body required")) };
                let prefs = b.get("prefs_json").cloned().unwrap_or(Value::Object(b));
                self.with(device, |s| { s.talon_preferences = Some(prefs.clone()); (reply(StatusCode::OK, json!({"prefs_json": prefs})), true) })
            }
            _ => self.route_item(device, method, path, body),
        }
    }

    fn route_item(&self, device: &str, method: &Method, path: &str, body: Option<Value>) -> Result<Response, ()> {
        let get = method == Method::GET || method == Method::HEAD;
        if let Some(raw) = single_segment(path, "/tv/layouts/") {
            let Some(id) = decode(raw) else { return Ok(bad("Invalid layout id")) };
            if *method == Method::DELETE {
                return self.with(device, |s| {
                    let before = s.layouts.len();
                    s.layouts.retain(|l| l.get("id").and_then(Value::as_str) != Some(id.as_str()));
                    let changed = s.layouts.len() != before;
                    if changed { s.layouts_updated = now_ms(); }
                    (empty(StatusCode::NO_CONTENT), changed)
                });
            }
            if *method != Method::PUT { return Ok(method_not_allowed()); }
            let Some(Value::Object(b)) = body else { return Ok(bad("Object body required")) };
            let force = b.get("force").and_then(Value::as_bool).unwrap_or(false);
            let base = b.get("baseVersion").and_then(Value::as_i64);
            return self.with(device, |s| {
                let now = now_ms();
                let position = s.layouts.iter().position(|l| l.get("id").and_then(Value::as_str) == Some(id.as_str()));
                let current = position.and_then(|p| s.layouts[p].get("version").and_then(Value::as_i64)).unwrap_or(0);
                if let (Some(p), Some(base)) = (position, base) {
                    if base != current && !force {
                        let updated = s.layouts[p].get("updatedAt").cloned().unwrap_or(json!(null));
                        return (reply(StatusCode::CONFLICT, json!({"currentVersion": current, "updatedAt": updated})), false);
                    }
                }
                let item = json!({"id": id, "name": b.get("name").cloned().unwrap_or(json!("Layout")),
                    "values": b.get("values").cloned().unwrap_or(json!({})), "version": current + 1, "updatedAt": now});
                match position { Some(p) => s.layouts[p] = item.clone(), None => s.layouts.push(item.clone()) }
                s.layouts_updated = now;
                (reply(StatusCode::OK, item), true)
            });
        }
        if let Some(raw) = single_segment(path, "/tv/drawings/") {
            let Some(symbol) = decode(raw) else { return Ok(bad("Invalid symbol")) };
            if get {
                return self.with(device, |s| (reply(StatusCode::OK, json!({"symbol": symbol,
                    "drawings": s.drawings.get(&symbol).cloned().unwrap_or(json!([])),
                    "updatedAt": s.drawings_updated.get(&symbol).cloned().unwrap_or(json!(null))})), false));
            }
            if *method != Method::PUT { return Ok(method_not_allowed()); }
            let Some(drawings) = body.as_ref().and_then(|b| b.get("drawings")).and_then(Value::as_array).cloned() else {
                return Ok(bad("drawings array required"));
            };
            // The original client rejects a reply unless every item has string id and tool.
            if !drawings.iter().all(|d| d.get("id").is_some_and(Value::is_string) && d.get("tool").is_some_and(Value::is_string)) {
                return Ok(bad("Each drawing needs string id and tool"));
            }
            return self.with(device, |s| {
                let now = now_ms();
                s.drawings.insert(symbol.clone(), Value::Array(drawings.clone()));
                s.drawings_updated.insert(symbol.clone(), json!(now));
                (reply(StatusCode::OK, json!({"symbol": symbol, "drawings": drawings, "updatedAt": now})), true)
            });
        }
        if let Some(raw) = single_segment(path, "/api/watchlists/") {
            let Some(id) = decode(raw) else { return Ok(bad("Invalid watchlist id")) };
            if *method == Method::DELETE {
                return self.with(device, |s| {
                    let before = s.watchlists.len();
                    s.watchlists.retain(|w| w.get("id").and_then(Value::as_str) != Some(id.as_str()));
                    (reply(StatusCode::OK, json!({"success": true})), s.watchlists.len() != before)
                });
            }
            if *method != Method::PUT { return Ok(method_not_allowed()); }
            let Some(Value::Object(b)) = body else { return Ok(bad("Object body required")) };
            return self.with(device, |s| {
                let Some(item) = s.watchlists.iter_mut().find(|w| w.get("id").and_then(Value::as_str) == Some(id.as_str())) else {
                    return (reply(StatusCode::NOT_FOUND, json!({"error": "Watchlist not found"})), false);
                };
                if let Value::Object(target) = item {
                    for (k, v) in b { if k != "id" && k != "created_at" { target.insert(k, v); } }
                    target.insert("updated_at".into(), json!(now_iso()));
                }
                (reply(StatusCode::OK, json!({"watchlist": item.clone()})), true)
            });
        }
        if let Some(raw) = single_segment(path, "/api/favorites/") {
            let Some(symbol) = decode(raw).filter(|s| valid_symbol(s)) else { return Ok(bad("Invalid symbol")) };
            let add = match *method { Method::POST => true, Method::DELETE => false, _ => return Ok(method_not_allowed()) };
            return self.with(device, |s| {
                let had = s.favorites.contains(&symbol);
                if add && !had { s.favorites.push(symbol.clone()); }
                if !add { s.favorites.retain(|f| f != &symbol); }
                (reply(StatusCode::OK, json!({"favorites": s.favorites})), add != had)
            });
        }
        Ok(method_not_allowed())
    }
}

fn method_not_allowed() -> Response { reply(StatusCode::METHOD_NOT_ALLOWED, json!({"error": "Method not allowed"})) }

/// Account/settings surfaces that company devices must not reach. Flowseeker pages
/// ("/flow/...") are hidden on request: they require the OPRA agreement, which this
/// account has not signed. Their data APIs ("/fs/api/...") stay reachable so other
/// pages that embed flow widgets keep working.
pub(crate) fn account_blocked(path: &str) -> bool {
    // "/nexus" pages are hidden on request (community/trade journal, write-only in
    // practice here). "/api/nexus/..." data APIs are NOT blocked: other pages use them.
    const PREFIXES: &[&str] = &["/flow", "/nexus", "/user-profile", "/user", "/developer", "/affiliate", "/invite",
        "/sign-in", "/sign-up", "/api/developer", "/api/njord/me/billing", "/api/njord/me/payment-settings",
        "/api/njord/me/api-credits", "/api/njord/me/invite", "/api/njord/me/partner-application",
        "/api/njord/me/commerce-eligibility", "/api/njord/me/affiliate", "/api/nexus/users/me"];
    PREFIXES.iter().any(|p| path == *p || path.strip_prefix(p).is_some_and(|rest| rest.starts_with('/')))
}

pub(crate) fn account_blocked_response(path: &str) -> Response {
    if path.starts_with("/api/") {
        return reply(StatusCode::FORBIDDEN, json!({"error": "disabled on company devices"}));
    }
    let html = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>已禁用</title>\
<main data-skylit-gateway-diagnostic=\"account-disabled\" style=\"font:16px system-ui;padding:3rem\">\
<h1>此页面在公司设备上已禁用</h1><p>账户、账单、开发者、邀请、Flowseeker 与 Nexus 页面不在公司设备上开放。</p>\
<p><a href=\"/\">返回首页</a></p></main></html>";
    let mut response = Response::new(Body::from(html));
    *response.status_mut() = StatusCode::FORBIDDEN;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    crate::local(response)
}
