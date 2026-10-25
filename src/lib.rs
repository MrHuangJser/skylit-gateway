//! A fixed-origin gateway with an optional, narrowly scoped trusted-secret session adapter.
//! Local authentication is NOT an upstream session.
mod session;
mod edge;
mod profile;
mod frontend;
mod device_state;
mod mirror;
mod brand;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{Html, IntoResponse, Response},
    Json, Router,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, env, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, Instant}};
use subtle::ConstantTimeEq;
use url::Url;

const UPSTREAM: &str = "https://app.skylit.ai";
const SESSION_TTL: Duration = Duration::from_secs(8 * 60 * 60);
/// Open-device mode: the device cookie IS the per-device state key, so keep it long.
const DEVICE_SESSION_TTL: Duration = Duration::from_secs(365 * 24 * 60 * 60);
const MAX_SESSIONS: usize = 4096;
const MAX_LOGIN_BODY: usize = 8192; // Fits a 1024-character token even with JSON Unicode escapes.

type SecretHash = [u8; 32];

/// Contains no configurable upstream: production always connects to UPSTREAM.
pub struct Config {
    access_hash: SecretHash,
    public_origin: String,
    cookie_secure: bool,
    session_file: Option<PathBuf>,
    enable_browser_auth_adapter: bool,
    enable_frontend_auth_rewrite: bool,
    /// No access code: every browser gets an automatic device identity.
    /// Same-origin/Host checks and the fixed upstream are still enforced.
    enable_open_device_access: bool,
    device_state_dir: Option<PathBuf>,
    frontend_mirror_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let token = env::var("GATEWAY_ACCESS_TOKEN")
            .map_err(|_| "GATEWAY_ACCESS_TOKEN must be configured".to_owned())?;
        // This is a strength floor, not an entropy estimator. Generate at least 32 random bytes.
        let mut distinct = [false; 128];
        for byte in token.bytes().filter(|b| b.is_ascii()) {
            distinct[byte as usize] = true;
        }
        if token.len() < 43 || token.len() > 1024
            || !token.bytes().all(|b| b.is_ascii_graphic())
            || distinct.iter().filter(|v| **v).count() < 12
        {
            return Err("GATEWAY_ACCESS_TOKEN needs 43..1024 printable ASCII characters, at least 12 distinct; use a cryptographically random value".into());
        }
        let origin = env::var("PUBLIC_ORIGIN")
            .map_err(|_| "PUBLIC_ORIGIN must be configured".to_owned())?;
        let public_origin = parse_origin(&origin)?;
        let cookie_secure = match env::var("COOKIE_SECURE") {
            Ok(value) if value == "true" => true,
            Ok(value) if value == "false" => false,
            Ok(_) => return Err("COOKIE_SECURE must be true or false".into()),
            Err(env::VarError::NotPresent) => true,
            Err(_) => return Err("COOKIE_SECURE must be valid text".into()),
        };
        if cookie_secure && !public_origin.starts_with("https://") {
            return Err("PUBLIC_ORIGIN must use HTTPS when COOKIE_SECURE=true".into());
        }
        // The path is configuration only; health/startup never opens or validates the secret file.
        let session_file = env::var_os("UPSTREAM_SESSION_FILE").map(PathBuf::from);
        let enable_browser_auth_adapter = browser_auth_enabled(env::var("ENABLE_BROWSER_AUTH_ADAPTER"))?;
        if enable_browser_auth_adapter && session_file.as_ref().is_none_or(|path| path.as_os_str().is_empty()) {
            return Err("UPSTREAM_SESSION_FILE is required when ENABLE_BROWSER_AUTH_ADAPTER=true".into());
        }
        let enable_frontend_auth_rewrite = frontend_auth_rewrite_enabled(env::var("ENABLE_FRONTEND_AUTH_REWRITE"))?;
        validate_frontend_auth_rewrite(enable_frontend_auth_rewrite, enable_browser_auth_adapter, session_file.as_deref())?;
        let enable_open_device_access = browser_auth_enabled(env::var("ENABLE_OPEN_DEVICE_ACCESS"))
            .map_err(|_| "ENABLE_OPEN_DEVICE_ACCESS must be true or false".to_owned())?;
        let device_state_dir = env::var_os("DEVICE_STATE_DIR").map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        if let Some(dir) = &device_state_dir {
            if !dir.is_dir() { return Err("DEVICE_STATE_DIR must be an existing directory".into()); }
        }
        // Optional: a captured frontend snapshot. Absent means every request proxies live,
        // which is the old behaviour, so a missing directory is not an error.
        let frontend_mirror_dir = env::var_os("FRONTEND_MIRROR_DIR").map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("frontend/mirror"));
        Ok(Self { access_hash: hash(token.as_bytes()), public_origin, cookie_secure, session_file,
            enable_browser_auth_adapter, enable_frontend_auth_rewrite, enable_open_device_access, device_state_dir,
            frontend_mirror_dir })
    }
}

fn browser_auth_enabled(value: Result<String, env::VarError>) -> Result<bool, String> {
    match value {
        Ok(value) if value == "true" => Ok(true),
        Ok(value) if value == "false" => Ok(false),
        Err(env::VarError::NotPresent) => Ok(false),
        _ => Err("ENABLE_BROWSER_AUTH_ADAPTER must be true or false".into()),
    }
}

fn frontend_auth_rewrite_enabled(value: Result<String, env::VarError>) -> Result<bool, String> {
    browser_auth_enabled(value).map_err(|_| "ENABLE_FRONTEND_AUTH_REWRITE must be true or false".into())
}

fn validate_frontend_auth_rewrite(enabled: bool, browser_adapter: bool, session_file: Option<&std::path::Path>) -> Result<(), String> {
    if enabled && (!browser_adapter || session_file.is_none_or(|p| p.as_os_str().is_empty())) {
        return Err("ENABLE_FRONTEND_AUTH_REWRITE=true requires ENABLE_BROWSER_AUTH_ADAPTER=true and UPSTREAM_SESSION_FILE".into());
    }
    Ok(())
}

fn parse_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "PUBLIC_ORIGIN must be an absolute HTTP(S) origin".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
    {
        return Err("PUBLIC_ORIGIN must contain only an HTTP(S) scheme, host and optional port".into());
    }
    Ok(url.origin().ascii_serialization())
}

struct Gateway {
    config: Config,
    upstream: Url,
    client: reqwest::Client,
    sessions: Mutex<HashMap<SecretHash, Instant>>,
    edge_lease: Mutex<Option<edge::CookieLease>>,
    devices: device_state::Store,
    /// Captured frontend snapshot; empty when absent, and then everything proxies live.
    mirror: mirror::Mirror,
    /// White-label rename + skin applied to snapshot bytes on the way out.
    brand: brand::Brand,
    /// Branded variants of snapshot text assets, computed once per file.
    branded: Mutex<HashMap<String, std::sync::Arc<Vec<u8>>>>,
    /// Process start, for the status report.
    started: Instant,
    /// Last comparison of the live upstream build against the pinned one.
    upstream_check: Mutex<Option<UpstreamCheck>>,
    /// (token hash, owner, verified at): the last positive upstream identity check.
    owner_check: Mutex<Option<(SecretHash, String, Instant)>>,
}

/// A data request reuses a positive identity check for the SAME token this long.
const OWNER_CHECK_TTL: Duration = Duration::from_secs(20);

/// The outcome of admitting one request: an identity, plus a cookie to issue
/// when the open-device mode created a brand new device for this browser.
struct Admission { device: Option<SecretHash>, issue_cookie: Option<String> }

impl Gateway {
    fn new(config: Config) -> Result<Self, reqwest::Error> {
        let upstream = Url::parse(UPSTREAM).expect("fixed valid upstream URL");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            // No whole-response timeout: SSE and other long-lived bodies must stream.
            .user_agent("skylit-gateway/0.1 transport-only")
            .build()?;
        let devices = device_state::Store::new(config.device_state_dir.clone());
        let mirror = mirror::Mirror::load(&config.frontend_mirror_dir);
        if mirror.is_empty() {
            eprintln!("frontend mirror: no snapshot at {}; serving live upstream", config.frontend_mirror_dir.display());
        } else {
            eprintln!("frontend mirror: {} files captured {}; static assets and the shell are served locally",
                mirror.len(), mirror.captured_at().unwrap_or("at an unknown time"));
        }
        let brand = brand::Brand::from_env();
        if brand.enabled() {
            eprintln!("brand: serving as \"{}\" (rename + skin applied at serve time)", brand.name());
        }
        Ok(Self { config, upstream, client, sessions: Mutex::new(HashMap::new()), edge_lease: Mutex::new(None), devices, mirror,
            brand, branded: Mutex::new(HashMap::new()), started: Instant::now(),
            upstream_check: Mutex::new(None), owner_check: Mutex::new(None) })
    }

    fn owner_verified_recently(&self, token: &SecretHash, owner: &str) -> bool {
        self.owner_check.lock().ok().is_some_and(|cached| cached.as_ref().is_some_and(|(t, o, at)|
            constant_eq(t, token) && o == owner && at.elapsed() < OWNER_CHECK_TTL))
    }
    fn remember_owner_verified(&self, token: SecretHash, owner: String) {
        if let Ok(mut cached) = self.owner_check.lock() { *cached = Some((token, owner, Instant::now())); }
    }

    /// Device-state interception and account blocking only apply to the company
    /// frontend modes; the default transport mode keeps its original behaviour.
    fn company_mode(&self) -> bool {
        self.config.enable_open_device_access || self.config.enable_frontend_auth_rewrite
    }

    /// In open mode the Host must be the configured public host, which prevents DNS
    /// rebinding from turning a hostile page into a same-origin caller.
    fn host_allowed(&self, headers: &HeaderMap) -> bool {
        if !self.config.enable_open_device_access { return true; }
        let Ok(origin) = Url::parse(&self.config.public_origin) else { return false };
        let Some(host) = origin.host_str() else { return false };
        let expected = match origin.port() { Some(port) => format!("{host}:{port}"), None => host.to_owned() };
        headers.get_all(header::HOST).iter().count() == 1
            && headers.get(header::HOST).and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.eq_ignore_ascii_case(&expected))
    }

    /// Admit a request. Returns None when it must be refused.
    fn admit(&self, headers: &HeaderMap) -> Option<Admission> {
        if self.authorized(headers) {
            return Some(Admission { device: self.session_hash(headers), issue_cookie: None });
        }
        if !self.config.enable_open_device_access { return None; }
        let mut secret = [0u8; 32];
        OsRng.try_fill_bytes(&mut secret).ok()?;
        let mut sessions = self.sessions.lock().ok()?;
        let now = Instant::now();
        if sessions.len() >= MAX_SESSIONS { sessions.retain(|_, expires| *expires > now); }
        if sessions.len() >= MAX_SESSIONS { return None; }
        let key = hash(&secret);
        sessions.insert(key, now + DEVICE_SESSION_TTL);
        Some(Admission { device: Some(key),
            issue_cookie: Some(self.cookie(&hex::encode(secret), DEVICE_SESSION_TTL.as_secs())) })
    }

    fn cookie_name(&self) -> &'static str {
        if self.config.cookie_secure { "__Host-skylit_gateway" } else { "skylit_gateway" }
    }

    fn cookie(&self, value: &str, max_age: u64) -> String {
        format!("{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
            self.cookie_name(), if self.config.cookie_secure { "; Secure" } else { "" })
    }

    fn session_hash(&self, headers: &HeaderMap) -> Option<SecretHash> {
        let mut found = None;
        for value in headers.get_all(header::COOKIE) {
            let value = value.to_str().ok()?;
            for pair in value.split(';') {
                if let Some((name, value)) = pair.trim().split_once('=') {
                    if name == self.cookie_name() {
                        if found.is_some() || value.len() != 64 { return None; }
                        let mut secret = [0u8; 32];
                        hex::decode_to_slice(value, &mut secret).ok()?;
                        found = Some(hash(&secret));
                    }
                }
            }
        }
        found
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        if headers.contains_key(header::AUTHORIZATION) {
            if headers.get_all(header::AUTHORIZATION).iter().count() != 1 { return false; }
            let local_bearer_valid = headers.get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|v| constant_eq(&hash(v.as_bytes()), &self.config.access_hash))
                .unwrap_or(false);
            if local_bearer_valid { return true; }
            if !self.config.enable_browser_auth_adapter { return false; }
            // The original frontend may attach its approved short vendor JWT. It is
            // NOT a gateway credential: admission still requires our own valid cookie.
            // proxy() drops this incoming header and uses the trusted runtime snapshot.

        }
        let Some(key) = self.session_hash(headers) else { return false; };
        // Poisoning fails closed, never panics or permits access.
        let Ok(mut sessions) = self.sessions.lock() else { return false; };
        match sessions.get(&key) {
            Some(expires) if *expires > Instant::now() => true,
            Some(_) => { sessions.remove(&key); false },
            None => false,
        }
    }

    fn same_origin(&self, headers: &HeaderMap) -> bool {
        if headers.get_all(header::ORIGIN).iter().count() != 1 { return false; }
        let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) else { return false };
        if origin == self.config.public_origin { return true; }
        // Some browser extensions rewrite Origin and drop the port (observed:
        // "http://127.0.0.1" for "http://127.0.0.1:48175"). Accept that exact
        // portless form only when the browser's own Fetch Metadata proves the
        // request is same-origin. Web pages cannot forge Sec-Fetch-Site, and it
        // compares the full origin including the port.
        let fetch_site_same_origin = headers.get_all("sec-fetch-site").iter().count() == 1
            && headers.get("sec-fetch-site").and_then(|h| h.to_str().ok()) == Some("same-origin");
        fetch_site_same_origin && self.portless_public_origin().is_some_and(|p| origin == p)
    }

    /// The configured origin with its explicit port removed, if it has one.
    fn portless_public_origin(&self) -> Option<String> {
        let url = Url::parse(&self.config.public_origin).ok()?;
        url.port()?;
        Some(format!("{}://{}", url.scheme(), url.host_str()?))
    }
}

fn hash(bytes: &[u8]) -> SecretHash { Sha256::digest(bytes).into() }
fn constant_eq(left: &SecretHash, right: &SecretHash) -> bool { bool::from(left.ct_eq(right)) }

pub fn router(config: Config) -> Result<Router, reqwest::Error> {
    let gateway = Arc::new(Gateway::new(config)?);
    // Only the real entry point starts the sentinel: it makes an upstream request, which
    // must never happen inside unit tests.
    spawn_upstream_sentinel(&gateway);
    Ok(router_with_state(gateway))
}

fn router_with_state(gateway: Arc<Gateway>) -> Router {
    Router::new().fallback(dispatch).with_state(gateway)
}

#[derive(Clone)]
struct UpstreamCheck {
    checked_at: Instant,
    matches_pinned: bool,
    live_chunks: Vec<String>,
}

/// Watches for an upstream rebuild. It never changes what is served: the snapshot is what
/// answers requests. It only records (and logs) that a refresh is due, so the failure is
/// noticed here instead of by a user hitting a page that no longer matches.
fn spawn_upstream_sentinel(gateway: &Arc<Gateway>) {
    let Some(mirror_has_pinned) = Some(!gateway.mirror.is_empty()) else { return };
    if !mirror_has_pinned { return; }
    let gateway = gateway.clone();
    tokio::spawn(async move {
        loop {
            let live = fetch_live_chunks(&gateway).await;
            if let Some(chunks) = live {
                let matches = frontend::pinned_names().iter().all(|name| chunks.iter().any(|c| c.ends_with(name)));
                let changed = match gateway.upstream_check.lock() {
                    Ok(mut slot) => {
                        let changed = slot.as_ref().is_none_or(|previous: &UpstreamCheck| previous.matches_pinned != matches);
                        *slot = Some(UpstreamCheck { checked_at: Instant::now(), matches_pinned: matches, live_chunks: chunks });
                        changed
                    }
                    Err(_) => false,
                };
                if changed {
                    if matches {
                        eprintln!("upstream build: still matches the pinned chunks");
                    } else {
                        eprintln!("upstream build: CHANGED (pinned chunks are gone); the snapshot keeps serving, refresh it when convenient");
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

/// Reads the live home document and collects the chunk file names it loads.
async fn fetch_live_chunks(gateway: &Gateway) -> Option<Vec<String>> {
    let response = tokio::time::timeout(Duration::from_secs(20), gateway.client.get(gateway.upstream.clone()).send())
        .await.ok()?.ok()?;
    if !response.status().is_success() { return None; }
    let body = tokio::time::timeout(Duration::from_secs(20), response.text()).await.ok()?.ok()?;
    let mut names = Vec::new();
    let mut rest = body.as_str();
    while let Some(at) = rest.find("/_next/static/chunks/") {
        rest = &rest[at + "/_next/static/chunks/".len()..];
        let end = rest.find(['"', '\'', ' ', '?']).unwrap_or(rest.len());
        let name = &rest[..end];
        if !name.is_empty() && !names.iter().any(|existing| existing == name) { names.push(name.to_owned()); }
        rest = &rest[end..];
    }
    (!names.is_empty()).then_some(names)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health { status: &'static str, phase: &'static str, upstream_session: bool }

const SESSION_PATHS: [&str; 4] = ["/api/access", "/api/access/entitlements", "/tv/search", "/tv/history"];
// Read routes observed during the real original-site regression. Runtime authorization
// now uses `frontend_read_gets_bearer` (all non-blocked reads); this list is kept as a
// regression fixture proving each observed route still receives the trusted token.
#[cfg(test)]
const FRONTEND_READ_PATHS: &[&str] = &[
    "/", "/atlas", "/api/nexus/legal/terms-status", "/api/symbols",
    "/api/nexus/support/tickets", "/agent-gateway/agenthub/tempest/access",
    "/api/access/api", "/api/access/marketplace-acquisition", "/api/njord/me/community-vote",
    "/api/nexus/notifications", "/agent-gateway/agenthub/dashboard/page-audience",
    "/api/status-notifications", "/api/stages", "/api/glitch/feed", "/siren/notifications",
    "/api/alerts", "/api/alert-events",
    // Atlas/Trinity chart reads observed failing with 401 "no_token" in a real Chrome session.
    "/tv/api/gex/levels", "/tv/api/ohlcv/symbols", "/tv/config", "/tv/plugins/_me", "/tv/alerts",
    "/api/nexus/futures/specs", "/api/nexus/paper-desk-access",
    // Layouts/drawings/presets/watchlists/favorites/preferences are per-device and local
    // (device_state); account surfaces are blocked. Neither belongs on this list.
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    supported_paths: [&'static str; 4],
    supported_methods: [&'static str; 2],
    full_website_ready: bool,
    browser_auth_adapter_enabled: bool,
    frontend_auth_rewrite_enabled: bool,
}

async fn dispatch(State(gateway): State<Arc<Gateway>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    if path == "/_gateway/health" {
        return if request.method() == Method::GET {
            let phase = if gateway.config.session_file.is_some() { "session-adapter-probe" } else { "transport-only" };
            local(Json(Health { status: "ok", phase, upstream_session: false }).into_response())
        } else { text(StatusCode::METHOD_NOT_ALLOWED, "GET only") };
    }
    if !gateway.host_allowed(request.headers()) {
        return text(StatusCode::MISDIRECTED_REQUEST, "Unexpected Host");
    }
    if path == "/_gateway/login" {
        if gateway.config.enable_open_device_access && request.method() == Method::GET {
            // No access code on company devices: the login page is no longer used.
            let mut response = text(StatusCode::FOUND, "");
            response.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/"));
            return response;
        }
        return if request.method() == Method::POST {
            login(&gateway, request).await
        } else if request.method() == Method::GET {
            login_page(StatusCode::OK)
        } else { text(StatusCode::METHOD_NOT_ALLOWED, "GET or POST only") };
    }
    let Some(admission) = gateway.admit(request.headers()) else {
        if path == "/_gateway/auth/bootstrap" {
            return if gateway.config.enable_browser_auth_adapter { text(StatusCode::UNAUTHORIZED, "Unauthorized") }
                else { text(StatusCode::NOT_FOUND, "Not found") };
        }
        // Never fetch, embed or redirect to the upstream before local authentication.
        return login_page(StatusCode::UNAUTHORIZED);
    };
    let issue_cookie = admission.issue_cookie.clone();
    let mut response = dispatch_admitted(&gateway, request, &path, admission).await;
    if let Some(cookie) = issue_cookie {
        if let Ok(value) = HeaderValue::from_str(&cookie) { response.headers_mut().append(header::SET_COOKIE, value); }
    }
    response
}

async fn dispatch_admitted(gateway: &Arc<Gateway>, request: Request, path: &str, admission: Admission) -> Response {
    let gateway = gateway.clone();
    // The root is not a page of its own in this build: the app's default view lives at a
    // client-side route. Redirect there so "/" always lands on the same view instead of
    // re-rendering whatever the client router last showed. Query strings are preserved so
    // per-symbol links (/ ?symbol=SPXW) keep working.
    if HOME_REDIRECTS.contains(&path) && gateway.config.enable_frontend_auth_rewrite
        && matches!(*request.method(), Method::GET | Method::HEAD)
    {
        let target = match request.uri().query() {
            Some(query) if !query.is_empty() => format!("{HOME_ROUTE}?{query}"),
            _ => HOME_ROUTE.to_owned(),
        };
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::FOUND;
        if let Ok(value) = HeaderValue::from_str(&target) { response.headers_mut().insert(header::LOCATION, value); }
        return local(response);
    }
    if path == "/_gateway/auth/bootstrap" {
        if !gateway.config.enable_browser_auth_adapter {
            return text(StatusCode::NOT_FOUND, "Not found");
        }
        // This endpoint never accepts upstream credentials or a destination from the caller.
        return browser_auth_bootstrap(&gateway, request).await;
    }
    if path == "/_gateway/diagnose" && gateway.config.enable_browser_auth_adapter {
        return diagnose_page();
    }
    // The replacement brand mark used wherever the original logo was referenced. Every
    // variant the app asks for (256px, 64px, dark/light) resolves to the same new mark.
    if path == brand::BRAND_LOGO_PATH || path.starts_with("/_gateway/brand/") {
        let mut response = Response::new(Body::from(gateway.brand.logo_svg(path)));
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/svg+xml"));
        return cacheable(local(response));
    }
    if path == "/_gateway/auth/adapter.js" {
        if !gateway.config.enable_frontend_auth_rewrite {
            return text(StatusCode::NOT_FOUND, "Not found");
        }
        if request.method() != Method::GET { return text(StatusCode::METHOD_NOT_ALLOWED, "GET only"); }
        return frontend::runtime_script();
    }
    // The original site registers a caching Service Worker that would serve the
    // UNREWRITTEN app shell from its cache, silently bypassing the auth adapter and
    // loading the real Clerk SDK (which rejects this domain). Replace it with a worker
    // that clears its caches, removes itself and reloads open tabs once.
    if gateway.config.enable_frontend_auth_rewrite
        && matches!(path, "/sw.js" | "/service-worker.js" | "/sw.js.map")
    {
        return frontend::retiring_service_worker();
    }
    // Operational status: what is being served, how old it is, and whether the upstream
    // build has moved on. Contains no token, cookie or identity.
    if path == "/_gateway/status" {
        if request.method() != Method::GET { return text(StatusCode::METHOD_NOT_ALLOWED, "GET only"); }
        return local(Json(status_report(&gateway)).into_response());
    }
    if path == "/manifest.webmanifest" && gateway.brand.enabled() {
        let mut response = Response::new(Body::from(gateway.brand.manifest()));
        response.headers_mut().insert(header::CONTENT_TYPE,
            HeaderValue::from_static("application/manifest+json"));
        return cacheable(local(response));
    }
    if path == "/_gateway/capabilities" {
        return if request.method() == Method::GET {
            local(Json(Capabilities {
                supported_paths: SESSION_PATHS,
                supported_methods: ["GET", "HEAD"],
                full_website_ready: false,
                browser_auth_adapter_enabled: gateway.config.enable_browser_auth_adapter,
                frontend_auth_rewrite_enabled: gateway.config.enable_frontend_auth_rewrite,
            }).into_response())
        } else { text(StatusCode::METHOD_NOT_ALLOWED, "GET only") };
    }
    if path == "/_gateway/logout" {
        if request.method() != Method::POST { return text(StatusCode::METHOD_NOT_ALLOWED, "POST only"); }
        if !gateway.same_origin(request.headers()) { return text(StatusCode::FORBIDDEN, "Same-origin Origin required"); }
        if let Some(key) = gateway.session_hash(request.headers()) {
            let Ok(mut sessions) = gateway.sessions.lock() else { return text(StatusCode::SERVICE_UNAVAILABLE, "Session store unavailable"); };
            sessions.remove(&key);
        }
        let mut response = text(StatusCode::NO_CONTENT, "");
        response.headers_mut().insert(header::SET_COOKIE,
            HeaderValue::from_str(&gateway.cookie("", 0)).expect("ASCII cookie"));
        return response;
    }
    if path == "/_gateway" || path.starts_with("/_gateway/") {
        return text(StatusCode::NOT_FOUND, "Unknown local gateway endpoint");
    }
    if gateway.company_mode() {
        if device_state::account_blocked(path) {
            return device_state::account_blocked_response(path);
        }
        if device_state::owns(path) {
            return device_state_request(&gateway, request, path, admission.device).await;
        }
        // Page-view telemetry: the original client ignores the result. Answer locally so
        // company-device browsing is not reported to the account and the console stays clean.
        if path == "/agent-gateway/platform/api/v1/usage/view" && request.method() == Method::POST {
            return text(StatusCode::NO_CONTENT, "");
        }
    }
    if gateway.config.enable_frontend_auth_rewrite && request.method() == Method::POST {
        if path == "/api/edge/cookies" { return edge_grant(&gateway, request).await; }
        if path == "/api/sse/ticket" { return sse_ticket(&gateway, request).await; }
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return text(StatusCode::FORBIDDEN, "Transport-only phase: upstream mutations are disabled");
    }
    // A captured snapshot answers static assets and the captured shell locally, so an
    // upstream rebuild cannot rename the chunks the adapter is pinned to. Misses still
    // proxy live, and data APIs never resolve here.
    if gateway.config.enable_frontend_auth_rewrite {
        if let Some(mirrored) = gateway.mirror.resolve(path) {
            return mirrored_response(&gateway, request.method(), path, mirrored).await;
        }
        // Aliases of the home view get the shell: the app only knows "/" (both DASHBOARD
        // and HEATMAPS link there), and "/" is redirected below so the client router does
        // not restore the previously open page.
        if SHELL_ROUTES.contains(&path) {
            if let Some(shell) = gateway.mirror.shell() {
                return mirrored_response(&gateway, request.method(), "/", shell).await;
            }
        }
        // Any other page the snapshot does not have is answered honestly. Returning the
        // shell made the client router render its default view, so unrelated URLs silently
        // looked like the heatmap page.
        if page_like(path) && gateway.mirror.shell().is_some() {
            return unknown_page(&gateway, path);
        }
    }
    proxy(&gateway, request).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusReport {
    status: &'static str,
    uptime_seconds: u64,
    brand: BrandStatus,
    snapshot: SnapshotStatus,
    session: SessionStatus,
    upstream: UpstreamStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrandStatus { enabled: bool, name: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotStatus {
    /// Null when no snapshot is installed (everything proxies live).
    captured_at: Option<String>,
    files: usize,
    pinned_chunks: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatus {
    /// Seconds left on the token the sidecar exported; null when it cannot be read.
    token_seconds_left: Option<i64>,
    /// What the sidecar last reported about itself, when it shares the session directory.
    sidecar_state: Option<String>,
    sidecar_checked_at: Option<String>,
    sign_ins: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamStatus {
    checked_seconds_ago: Option<u64>,
    /// True while the live build still contains the chunks this snapshot is pinned to.
    matches_pinned: Option<bool>,
    live_chunks: Option<usize>,
}

/// Seconds since the unix epoch, or 0 when the clock is before it (never in practice).
fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn status_report(gateway: &Gateway) -> StatusReport {
    let session = gateway.config.session_file.as_ref().and_then(|file| std::fs::read(file).ok());
    let sidecar = gateway.config.session_file.as_ref()
        .and_then(|file| file.parent().map(|dir| dir.join("sidecar-status.json")))
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());
    let token_seconds_left = session
        .as_deref()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(raw).ok())
        .and_then(|value| value.get("expiresAt").and_then(|at| at.as_i64()))
        .map(|expires| expires - unix_now());
    let (checked_seconds_ago, matches_pinned, live_chunks) = match gateway.upstream_check.lock() {
        Ok(slot) => slot.as_ref().map_or((None, None, None), |check| (
            Some(check.checked_at.elapsed().as_secs()), Some(check.matches_pinned), Some(check.live_chunks.len()))),
        Err(_) => (None, None, None),
    };
    StatusReport {
        status: "ok",
        uptime_seconds: gateway.started.elapsed().as_secs(),
        brand: BrandStatus { enabled: gateway.brand.enabled(), name: gateway.brand.name().to_owned() },
        snapshot: SnapshotStatus {
            captured_at: gateway.mirror.captured_at().map(str::to_owned),
            files: gateway.mirror.len(),
            pinned_chunks: frontend::pinned_names().to_vec(),
        },
        session: SessionStatus {
            token_seconds_left,
            sidecar_state: sidecar.as_ref().and_then(|v| v.get("state")).and_then(|v| v.as_str()).map(str::to_owned),
            sidecar_checked_at: sidecar.as_ref().and_then(|v| v.get("checkedAt")).and_then(|v| v.as_str()).map(str::to_owned),
            sign_ins: sidecar.as_ref().and_then(|v| v.get("signIns")).and_then(serde_json::Value::as_u64),
        },
        upstream: UpstreamStatus { checked_seconds_ago, matches_pinned, live_chunks },
    }
}

fn unknown_page(gateway: &Gateway, path: &str) -> Response {
    let name = gateway.brand.name();
    let html = format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{name}</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e9e5e2;
font:14px/1.6 'PingFang SC','Microsoft YaHei',system-ui,sans-serif}}main{{max-width:34rem;padding:2rem;text-align:center}}
h1{{font-size:1.1rem;font-weight:600;margin:0 0 .75rem}}code{{background:#1b1b1e;padding:.1rem .35rem;border-radius:4px}}
p{{color:#9b9490;margin:.35rem 0}}</style>
<main><h1>这个页面不在当前缓存的前端版本里</h1>
<p><code>{path}</code> 没有收录进快照，所以没有可用的界面。</p>
<p>请从侧栏进入，或使用首页 <code>/</code>。</p></main></html>"#,
        name = name, path = path);
    let mut response = Response::new(Body::from(html));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    local(response)
}

/// A browser page path, as opposed to an asset or a data endpoint.
fn page_like(path: &str) -> bool {
    if path.starts_with("/_next/") || path.starts_with("/_gateway") { return false; }
    // Any path with a file extension is an asset request, not a client route.
    let last = path.rsplit('/').next().unwrap_or("");
    if last.contains('.') { return false; }
    // Data/API surfaces must never receive an HTML shell.
    const DATA_PREFIXES: [&str; 8] = [
        "/api/", "/tv/", "/siren/", "/agent-gateway/", "/fs/", "/flow/", "/nexus/", "/fs",
    ];
    let with_slash = format!("{path}/");
    !DATA_PREFIXES.iter().any(|prefix| path.starts_with(prefix) || with_slash.starts_with(prefix))
}

/// Serves one snapshot file. Documents go through the same rewrite the live path uses, so
/// the adapter injection, account hiding and Clerk removal behave identically.
/// Returns the branded variant of a text asset, computing it at most once per path.
fn branded_bytes(gateway: &Gateway, path: &str, content_type: &str, bytes: &[u8]) -> Option<std::sync::Arc<Vec<u8>>> {
    if !gateway.brand.enabled() || !brand::is_text_asset(content_type, path) { return None; }
    let key = format!("{path}|{content_type}");
    if let Ok(cache) = gateway.branded.lock() {
        if let Some(hit) = cache.get(&key) { return Some(hit.clone()); }
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let rewritten = gateway.brand.rewrite(text)?;
    let value = std::sync::Arc::new(rewritten.into_bytes());
    if let Ok(mut cache) = gateway.branded.lock() { cache.insert(key, value.clone()); }
    Some(value)
}

async fn mirrored_response(gateway: &Gateway, method: &Method, path: &str, mirrored: mirror::Mirrored) -> Response {
    let bytes = match tokio::fs::read(&mirrored.file).await {
        Ok(bytes) => bytes,
        Err(error) => {
            // Name the real cause: "missing" hid a permission or path problem more than once.
            eprintln!("frontend mirror: cannot read {} ({error})", mirrored.file.display());
            return text(StatusCode::NOT_FOUND, "Not found");
        }
    };
    // A pinned chunk is served as the PATCHED bytes, but only when the snapshot file is
    // exactly the build those patches were generated from. This keeps the adapter working
    // without contacting upstream at all.
    if let Some((original_sha256, patched)) = frontend::patch_for(path) {
        if frontend::sha256_hex(&bytes) != original_sha256 {
            eprintln!("frontend mirror: {path} in the snapshot is not the pinned build");
            return text(StatusCode::BAD_GATEWAY, "Snapshot does not match the pinned build");
        }
        let body = branded_bytes(gateway, path, "application/javascript", patched)
            .map(|bytes| Body::from(bytes.as_ref().clone()))
            .unwrap_or_else(|| Body::from(patched));
        let mut response = Response::new(body);
        response.headers_mut().insert(header::CONTENT_TYPE,
            HeaderValue::from_static("application/javascript; charset=utf-8"));
        response.headers_mut().insert("x-skylit-gateway-adapter", HeaderValue::from_static("version-pinned"));
        response.headers_mut().insert("x-skylit-frontend-source", HeaderValue::from_static("snapshot"));
        return local(response);
    }
    if mirrored.document {
        let mut bytes = bytes;
        // A captured dynamic page embeds the id it was captured for: swap it for the id the
        // caller asked for, so the page loads that record instead of the sample one.
        if let Some((from, to)) = &mirrored.substitute {
            if let Ok(text) = String::from_utf8(std::mem::take(&mut bytes)) {
                bytes = text.replace(from.as_str(), to.as_str()).into_bytes();
            }
        }
        let Ok(text_body) = String::from_utf8(bytes) else {
            return text(StatusCode::BAD_GATEWAY, "Snapshot document is not UTF-8");
        };
        return match frontend::rewrite_document(&text_body) {
            Ok(rewritten) => {
                let branded = gateway.brand.rewrite_document(&rewritten);
                let sheet = if gateway.brand.enabled() { gateway.brand.stylesheet() } else { String::new() };
                let document = brand::inject_stylesheet(&branded, &sheet);
                let mut response = Response::new(Body::from(document));
                response.headers_mut().insert(header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"));
                response.headers_mut().insert("x-skylit-gateway-adapter", HeaderValue::from_static("version-pinned"));
                response.headers_mut().insert("x-skylit-frontend-source", HeaderValue::from_static("snapshot"));
                local(response)
            }
            Err(error) => error.response(),
        };
    }
    let body = match branded_bytes(gateway, path, mirrored.content_type, &bytes) {
        Some(branded) => Body::from(branded.as_ref().clone()),
        None => Body::from(bytes),
    };
    let mut response = Response::new(body);
    if method == Method::HEAD { *response.body_mut() = Body::empty(); }
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mirrored.content_type));
    response.headers_mut().insert("x-skylit-frontend-source", HeaderValue::from_static("snapshot"));
    let response = local(response);
    // Snapshot files are content-addressed by name and fixed for the life of the image.
    if immutable_static_asset_for(mirrored.content_type) { cacheable(response) } else { response }
}

fn immutable_static_asset_for(content_type: &str) -> bool {
    !content_type.starts_with("text/html")
}

/// Paths that mean "open the home view". `/` is the app's own route; `/dashboard` is what
/// the sidebar's DASHBOARD entry is labelled, and typing it should not look like a bad URL.
const HOME_REDIRECTS: [&str; 2] = ["/", "/dashboard"];

/// Paths that render the home view. The app itself only routes "/"; "/heatmaps" is the
/// redirect target, kept so an old bookmark still lands on the same view.
/// The home view has no document of its own in this build: the app routes "/" to it, so
/// these get the shell. Every other page comes from the snapshot; an uncaptured path is a
/// 404, because serving the shell for it silently rendered the home view (an unknown route
/// looked identical to the heatmap page).
const SHELL_ROUTES: [&str; 2] = ["/", "/heatmaps"];

/// Where "/" sends the browser. The app renders this view client-side; upstream answers
/// it with 404, which is why the gateway serves the captured shell for it.
const HOME_ROUTE: &str = "/heatmaps";

const MAX_ACCESS_BODY: usize = 64 * 1024;

/// Proxy-local per-device UI state. Never forwarded to the upstream.
async fn device_state_request(gateway: &Gateway, request: Request, path: &str, device: Option<SecretHash>) -> Response {
    let Some(device) = device else { return text(StatusCode::UNAUTHORIZED, "Device identity required") };
    let device = hex::encode(device);
    let method = request.method().clone();
    let writes = !(method == Method::GET || method == Method::HEAD);
    if writes {
        if !gateway.same_origin(request.headers()) { return text(StatusCode::FORBIDDEN, "Same-origin Origin required"); }
        let types = request.headers().get_all(header::CONTENT_TYPE);
        let count = types.iter().count();
        let json = count == 1 && types.iter().next().and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"));
        if count > 1 || (count == 1 && !json) {
            return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json required");
        }
    }
    let if_none_match = request.headers().get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok()).map(str::to_owned);
    let bytes = match tokio::time::timeout(Duration::from_secs(10),
        to_bytes(request.into_body(), device_state::MAX_BODY)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return text(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        Err(_) => return text(StatusCode::REQUEST_TIMEOUT, "Request body timed out"),
    };
    gateway.devices.handle(&device, &method, path, if_none_match.as_deref(), &bytes)
}

#[derive(Deserialize)]
struct VerifiedAccess { user_id: String, application: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserBootstrap<'a> {
    source: &'static str,
    user: serde_json::Value,
    session: serde_json::Value,
    organization: serde_json::Value,
    profile_complete: bool,
    user_source: &'static str,
    token: &'a str,
    expires_at: u64,
    full_website_ready: bool,
}

async fn browser_auth_bootstrap(gateway: &Gateway, request: Request) -> Response {
    if request.method() != Method::POST { return text(StatusCode::METHOD_NOT_ALLOWED, "POST only"); }
    if !gateway.same_origin(request.headers()) {
        // Record what the browser actually sent (origin value only, never cookies/tokens)
        // so a browser that rewrites Origin can be diagnosed.
        let origin = request.headers().get_all(header::ORIGIN).iter()
            .map(|v| v.to_str().unwrap_or("<non-ascii>").chars().take(80).collect::<String>())
            .collect::<Vec<_>>().join(",");
        eprintln!("bootstrap rejected: origin mismatch (got [{origin}], expected [{}])", gateway.config.public_origin);
        return text(StatusCode::FORBIDDEN, "Same-origin Origin required");
    }
    let content_types = request.headers().get_all(header::CONTENT_TYPE);
    if content_types.iter().count() != 1 || !content_types.iter().next()
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"))
    {
        return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json required");
    }
    let Some(path) = gateway.config.session_file.as_deref() else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Upstream session unavailable");
    };
    let snapshot = match session::TokenSnapshot::load(path).await {
        Ok(snapshot) => snapshot,
        Err(_) => {
            eprintln!("bootstrap rejected: intermediary token snapshot missing or expired");
            return text(StatusCode::SERVICE_UNAVAILABLE, "Upstream session unavailable");
        }
    };
    let mut target = gateway.upstream.clone();
    target.set_path("/api/access");
    target.set_query(None);
    target.set_fragment(None);
    // One deadline covers send, all body chunks, and parsing. Never forward client
    // headers/cookies/body or propagate upstream headers (including CORS/Set-Cookie).
    let verified = tokio::time::timeout(Duration::from_secs(10), async {
        let mut response = gateway.client.get(target)
            .header(header::AUTHORIZATION, snapshot.authorization())
            .header(header::ACCEPT, "application/json")
            .send().await.map_err(|_| ())?;
        if response.status() != StatusCode::OK { return Err(()); }
        if response.content_length().is_some_and(|n| n > MAX_ACCESS_BODY as u64) { return Err(()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if chunk.len() > MAX_ACCESS_BODY - bytes.len() { return Err(()); }
            bytes.extend_from_slice(&chunk);
        }
        let access: VerifiedAccess = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if !access.application || access.user_id.trim().is_empty() { return Err(()); }
        Ok(access)
    }).await;
    let Ok(Ok(access)) = verified else {
        eprintln!("bootstrap rejected: upstream account verification failed");
        return text(StatusCode::SERVICE_UNAVAILABLE, "Upstream verification unavailable");
    };
    let profile = match tokio::time::timeout(Duration::from_secs(10), profile::BrowserProfile::load(path, &access.user_id)).await {
        Ok(Ok(profile)) => profile,
        _ => {
            eprintln!("bootstrap rejected: intermediary browser profile missing or stale");
            return text(StatusCode::SERVICE_UNAVAILABLE, "Browser profile unavailable");
        }
    };
    // Do not hand out a token which expired while verification was in flight.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    if !now.is_ok_and(|now| now.as_secs() < snapshot.expires_at()) {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Upstream session unavailable");
    }
    local(Json(BrowserBootstrap {
        source: "upstream-verified",
        user: profile.user,
        session: profile.session,
        organization: profile.organization,
        profile_complete: true,
        user_source: "normal-clerk-session",
        token: snapshot.browser_token(),
        expires_at: snapshot.expires_at(),
        full_website_ready: false,
    }).into_response())
}

// These two fixed POST capabilities never reuse incoming identity, cookies, query or destination.
fn fixed_target(gateway: &Gateway, path: &str) -> Url {
    let mut target = gateway.upstream.clone();
    target.set_path(path);
    target.set_query(None);
    target.set_fragment(None);
    target
}
fn snapshot_live(snapshot: &session::TokenSnapshot) -> bool {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .is_ok_and(|now| now.as_secs() < snapshot.expires_at())
}
async fn bounded_upstream(response: &mut reqwest::Response) -> Result<Vec<u8>, ()> {
    if response.content_length().is_some_and(|n| n > MAX_ACCESS_BODY as u64) { return Err(()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > MAX_ACCESS_BODY - bytes.len() { return Err(()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn bounded_post_body(request: Request) -> Result<axum::body::Bytes, Response> {
    match tokio::time::timeout(Duration::from_secs(10), to_bytes(request.into_body(), MAX_LOGIN_BODY)).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(_)) => Err(text(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large")),
        Err(_) => Err(text(StatusCode::SERVICE_UNAVAILABLE, "Upstream capability unavailable")),
    }
}
async fn edge_grant(gateway: &Gateway, request: Request) -> Response {
    if !gateway.same_origin(request.headers()) { return text(StatusCode::FORBIDDEN, "Same-origin Origin required"); }
    // Consume a bounded caller body, but the grant request is always exactly {}.
    if let Err(response) = bounded_post_body(request).await { return response; }
    let granted = tokio::time::timeout(Duration::from_secs(10), async {
        let path = gateway.config.session_file.as_deref().ok_or(())?;
        let snapshot = session::TokenSnapshot::load(path).await.map_err(|_| ())?;
        let mut access = gateway.client.get(fixed_target(gateway, "/api/access"))
            .header(header::AUTHORIZATION, snapshot.authorization())
            .header(header::ACCEPT, "application/json").send().await.map_err(|_| ())?;
        if access.status() != StatusCode::OK { return Err(()); }
        let access: VerifiedAccess = serde_json::from_slice(&bounded_upstream(&mut access).await?).map_err(|_| ())?;
        if !access.application || access.user_id.trim().is_empty() { return Err(()); }
        profile::BrowserProfile::load(path, &access.user_id).await.map_err(|_| ())?;
        if !snapshot_live(&snapshot) { return Err(()); }
        let started = Instant::now();
        let mut response = gateway.client.post(fixed_target(gateway, "/api/edge/cookies"))
            .header(header::AUTHORIZATION, snapshot.authorization())
            .header(header::ORIGIN, gateway.upstream.origin().ascii_serialization())
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json").body("{}")
            .send().await.map_err(|_| ())?;
        if response.status() != StatusCode::OK { return Err(()); }
        let value: serde_json::Value = serde_json::from_slice(&bounded_upstream(&mut response).await?).map_err(|_| ())?;
        let ttl = value.get("ttlSeconds").and_then(serde_json::Value::as_u64).ok_or(())?;
        let lease = edge::CookieLease::parse(response.headers(), access.user_id, ttl, started).map_err(|_| ())?;
        if !snapshot_live(&snapshot) { return Err(()); }
        let ttl = lease.ttl_seconds();
        if lease.expires <= Instant::now() { return Err(()); }
        let mut output = serde_json::json!({"ttlSeconds": ttl});
        if let Some(expires) = value.get("expiresAt").filter(|v| v.is_string() || v.is_number()) {
            output["expiresAt"] = expires.clone();
        }
        *gateway.edge_lease.lock().map_err(|_| ())? = Some(lease);
        Ok(output)
    }).await;
    match granted {
        Ok(Ok(value)) => local(Json(value).into_response()),
        _ => text(StatusCode::SERVICE_UNAVAILABLE, "Upstream capability unavailable"),
    }
}
async fn sse_ticket(gateway: &Gateway, request: Request) -> Response {
    if !gateway.same_origin(request.headers()) { return text(StatusCode::FORBIDDEN, "Same-origin Origin required"); }
    let types = request.headers().get_all(header::CONTENT_TYPE);
    let no_content_type = types.iter().count() == 0;
    let json_content_type = types.iter().count() == 1 && types.iter().next().and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"));
    if !no_content_type && !json_content_type {
        return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json required");
    }
    let mut bytes = match bounded_post_body(request).await { Ok(bytes) => bytes, Err(response) => return response };
    // The real website issues this capability with an empty POST and no Content-Type.
    // Keep the existing same-origin/local-auth requirements; only normalize that
    // empty input, never interpret a non-JSON body as an authenticated instruction.
    if bytes.is_empty() { bytes = axum::body::Bytes::from_static(b"{}"); }
    else if !json_content_type { return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json required"); }
    if serde_json::from_slice::<serde_json::Value>(&bytes).is_err() { return text(StatusCode::BAD_REQUEST, "Invalid request JSON"); }
    let issued = tokio::time::timeout(Duration::from_secs(10), async {
        let path = gateway.config.session_file.as_deref().ok_or(())?;
        let snapshot = session::TokenSnapshot::load(path).await.map_err(|_| ())?;
        let mut response = gateway.client.post(fixed_target(gateway, "/api/sse/ticket"))
            .header(header::AUTHORIZATION, snapshot.authorization())
            .header(header::ORIGIN, gateway.upstream.origin().ascii_serialization())
            .header(header::CONTENT_TYPE, "application/json").header(header::ACCEPT, "application/json")
            .body(bytes).send().await.map_err(|_| ())?;
        let status = response.status();
        if status.is_redirection() || status.is_informational() { return Err(()); }
        let bytes = bounded_upstream(&mut response).await?;
        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) if status.is_client_error() || status.is_server_error() => serde_json::json!({"error":"Upstream ticket request failed"}),
            Err(_) => return Err(()),
        };
        // Construct fresh JSON headers only; never expose upstream Set-Cookie/CORS/redirects.
        Ok((status, value))
    }).await;
    match issued {
        Ok(Ok((status, value))) => local((status, Json(value)).into_response()),
        _ => text(StatusCode::SERVICE_UNAVAILABLE, "Upstream capability unavailable"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Login { access_token: String }

async fn login(gateway: &Gateway, request: Request) -> Response {
    if !gateway.same_origin(request.headers()) {
        return text(StatusCode::FORBIDDEN, "Same-origin Origin required");
    }
    let content_type = request.headers().get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    if !content_type.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json") {
        return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json required");
    }
    // Axum Json uses the same bounded body; parsing through Json avoids another public parser dependency.
    let bytes = match to_bytes(request.into_body(), MAX_LOGIN_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "Login body too large"),
    };
    let request = Request::builder().header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes)).expect("static request builder");
    use axum::extract::FromRequest;
    let Json(login) = match Json::<Login>::from_request(request, &()).await {
        Ok(value) => value,
        Err(_) => return text(StatusCode::BAD_REQUEST, "Invalid login JSON"),
    };
    if !constant_eq(&hash(login.access_token.as_bytes()), &gateway.config.access_hash) {
        return text(StatusCode::UNAUTHORIZED, "Invalid access token");
    }
    let mut secret = [0u8; 32];
    if OsRng.try_fill_bytes(&mut secret).is_err() {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Secure randomness unavailable");
    }
    let Ok(mut sessions) = gateway.sessions.lock() else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Session store unavailable");
    };
    let now = Instant::now();
    sessions.retain(|_, expires| *expires > now);
    if sessions.len() >= MAX_SESSIONS {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Local session capacity reached");
    }
    sessions.insert(hash(&secret), now + SESSION_TTL);
    let mut response = text(StatusCode::NO_CONTENT, "");
    response.headers_mut().insert(header::SET_COOKIE,
        HeaderValue::from_str(&gateway.cookie(&hex::encode(secret), SESSION_TTL.as_secs())).expect("ASCII cookie"));
    response
}

// Connection header nominations must be stripped as well as the standard hop-by-hop fields.
fn hop_headers(headers: &HeaderMap) -> Vec<HeaderName> {
    let mut names = vec![header::CONNECTION, header::TRANSFER_ENCODING, header::UPGRADE,
        header::PROXY_AUTHENTICATE, header::PROXY_AUTHORIZATION, header::TE, header::TRAILER,
        HeaderName::from_static("keep-alive"), HeaderName::from_static("proxy-connection")];
    for value in headers.get_all(header::CONNECTION) {
        if let Ok(value) = value.to_str() {
            for name in value.split(',').map(str::trim) {
                if let Ok(name) = HeaderName::from_bytes(name.as_bytes()) { names.push(name); }
            }
        }
    }
    names
}

/// Company frontend mode: which GET/HEAD reads carry the intermediary's normal token.
///
/// An exact allowlist kept breaking real pages: every page or API missing from it
/// was rendered anonymously, so the upstream answered 401 or redirected the whole
/// page to its sign-in host (shown as a 502). Reads are therefore authorized by
/// default. Writes stay forbidden elsewhere, account surfaces are blocked before this
/// point, and content-hashed public assets never need (or get) the token.
fn frontend_read_gets_bearer(path: &str) -> bool {
    !path.starts_with("/_next/") && !path.starts_with("/_gateway") && !device_state::account_blocked(path)
}

async fn proxy(gateway: &Gateway, request: Request) -> Response {
    // Do NOT join untrusted paths: a //host path must not change the destination origin.
    let mut target = gateway.upstream.clone();
    target.set_path(request.uri().path());
    target.set_query(request.uri().query());
    target.set_fragment(None);
    let blocked = hop_headers(request.headers());
    let mut outgoing = HeaderMap::new();
    // An allowlist also excludes spoofed forwarding headers, credentials, Origin and Referer.
    for name in ["accept", "accept-language", "if-none-match", "if-modified-since", "range",
        "if-range", "cache-control", "last-event-id"]
    {
        let name = HeaderName::from_static(name);
        if !blocked.contains(&name) {
            for value in request.headers().get_all(&name) { outgoing.append(name.clone(), value.clone()); }
        }
    }
    if gateway.config.enable_frontend_auth_rewrite {
        // Preserve Next navigation protocol, but never reuse an original-body cache
        // validator or range for a resource whose bytes will be transformed.
        for name in ["rsc", "next-router-state-tree", "next-router-prefetch", "next-url"] {
            let name = HeaderName::from_static(name);
            if !blocked.contains(&name) {
                for value in request.headers().get_all(&name) { outgoing.append(name.clone(), value.clone()); }
            }
        }
        if frontend::is_pinned_script(request.uri().path()) || matches!(request.uri().path(), "/" | "/atlas") {
            for name in ["if-none-match", "if-modified-since", "range", "if-range"] { outgoing.remove(name); }
        }
    }
    if gateway.config.enable_frontend_auth_rewrite && edge::is_data_path(request.uri().path()) {
        let credentials = tokio::time::timeout(Duration::from_secs(10), async {
            let path = gateway.config.session_file.as_deref().ok_or(())?;
            let owner = {
                let guard = gateway.edge_lease.lock().map_err(|_| ())?;
                let lease = guard.as_ref().filter(|l| l.expires > Instant::now()).ok_or(())?;
                lease.owner.clone()
            };
            let snapshot = session::TokenSnapshot::load(path).await.map_err(|_| ())?;
            // Reload the short-lived normal profile before every send. Account switches
            // invalidate the old lease; an untrusted incoming JWT is never an owner claim.
            profile::BrowserProfile::load(path, &owner).await.map_err(|_| ())?;
            // Snapshot and profile are separate files. A fresh profile alone cannot
            // prove a newly rotated snapshot still belongs to this owner. Ask the
            // normal upstream access endpoint; never decode/trust a caller JWT.
            // That check cost a full upstream round trip on EVERY data request, so a
            // positive result is cached briefly, keyed by the exact token. A rotated
            // token is a cache miss and is verified again before any data is sent.
            let token_key = hash(snapshot.authorization().as_bytes());
            if !gateway.owner_verified_recently(&token_key, &owner) {
                let mut access = gateway.client.get(fixed_target(gateway, "/api/access"))
                    .header(header::AUTHORIZATION, snapshot.authorization())
                    .header(header::ACCEPT, "application/json").send().await.map_err(|_| ())?;
                if access.status() != StatusCode::OK { return Err(()); }
                let access: VerifiedAccess = serde_json::from_slice(&bounded_upstream(&mut access).await?).map_err(|_| ())?;
                if !access.application || access.user_id != owner { return Err(()); }
                gateway.remember_owner_verified(token_key, owner.clone());
            }
            if !snapshot_live(&snapshot) { return Err(()); }
            let cookie = {
                let guard = gateway.edge_lease.lock().map_err(|_| ())?;
                let lease = guard.as_ref().filter(|l| l.owner == owner).ok_or(())?;
                lease.cookie().ok_or(())?
            };
            Ok((snapshot.into_authorization(), cookie))
        }).await;
        let Ok(Ok((authorization, cookie))) = credentials else {
            return text(StatusCode::SERVICE_UNAVAILABLE, "Upstream capability unavailable");
        };
        outgoing.insert(header::AUTHORIZATION, authorization);
        outgoing.insert(header::COOKIE, cookie);
    }
    // Only these exact read paths may use trusted runtime credentials. Inbound auth/cookies
    // remain filtered; a configured but unavailable snapshot must never fall back to anonymous.
    if (request.method() == Method::GET || request.method() == Method::HEAD)
        && (SESSION_PATHS.contains(&request.uri().path())
            || (gateway.config.enable_frontend_auth_rewrite
                && frontend_read_gets_bearer(request.uri().path())))
    {
        if let Some(path) = gateway.config.session_file.as_deref() {
            let snapshot = match session::TokenSnapshot::load(path).await {
                Ok(snapshot) => snapshot,
                Err(_) => return text(StatusCode::SERVICE_UNAVAILABLE, "Upstream session unavailable"),
            };
            outgoing.insert(header::AUTHORIZATION, snapshot.into_authorization());
        }
    }
    // Bound the wait for headers without imposing a whole-body timeout on streams.
    let result = tokio::time::timeout(Duration::from_secs(30),
        gateway.client.request(request.method().clone(), target.clone()).headers(outgoing).send()).await;
    let mut upstream = match result {
        Ok(Ok(response)) => response,
        // Do not expose reqwest errors: they can contain request URL/query data.
        Ok(Err(_)) => return text(StatusCode::BAD_GATEWAY, "Upstream transport failed"),
        Err(_) => return text(StatusCode::GATEWAY_TIMEOUT, "Upstream response headers timed out"),
    };
    let status = upstream.status();
    if status == StatusCode::SWITCHING_PROTOCOLS {
        return text(StatusCode::BAD_GATEWAY, "Protocol upgrades are not supported");
    }
    let mut headers = upstream.headers().clone();
    if let Some(location) = headers.get(header::LOCATION) {
        let rewritten = location.to_str().ok().and_then(|value| target.join(value).ok())
            .filter(|url| url.origin() == gateway.upstream.origin()
                && url.username().is_empty() && url.password().is_none())
            .and_then(|url| {
                let mut path = url.path().to_owned();
                if let Some(query) = url.query() { path.push('?'); path.push_str(query); }
                if let Some(fragment) = url.fragment() { path.push('#'); path.push_str(fragment); }
                // A scheme-relative path would become an external browser redirect.
                if path.starts_with("//") { return None; }
                HeaderValue::from_str(&path).ok()
            });
        let Some(rewritten) = rewritten else {
            return text(StatusCode::BAD_GATEWAY, "External or invalid upstream redirect blocked");
        };
        headers.insert(header::LOCATION, rewritten);
    }
    for name in hop_headers(&headers) { headers.remove(name); }
    headers.remove(header::SET_COOKIE);
    headers.remove(header::CONTENT_LENGTH); // Hyper frames the streamed body; never forward hop framing.
    // These can cause browser-side navigation, clear the local cookie, or advertise alternate origins.
    headers.remove("refresh");
    headers.remove("clear-site-data");
    headers.remove("alt-svc");
    if gateway.config.enable_frontend_auth_rewrite && request.method() == Method::GET {
        match frontend::rewrite_if_needed(request.uri().path(), &mut upstream, &headers).await {
            Ok(Some(response)) => return response,
            Ok(None) => (),
            Err(error) => return error.response(),
        }
    }
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
    let response = local(response);
    // Content-hashed public build assets (the name changes whenever the bytes do)
    // are safe to cache in the browser. Without this every page view re-downloaded
    // ~11 MB. The two rewritten auth chunks never reach here: they return earlier.
    if status == StatusCode::OK && immutable_static_asset(request.uri().path()) {
        return cacheable(response);
    }
    response
}

fn immutable_static_asset(path: &str) -> bool {
    path.starts_with("/_next/static/") && !path.contains("..") && !frontend::is_pinned_script(path)
}
fn cacheable(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"));
    response
}

fn local(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    response.headers_mut().insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
fn text(status: StatusCode, message: &'static str) -> Response { local((status, message).into_response()) }
/// Browser self-check: runs the same bootstrap call the page makes and shows only
/// status codes and booleans. It never displays the token, cookie values or identity.
fn diagnose_page() -> Response {
    let mut response = local((StatusCode::OK, Html(include_str!("diagnose.html"))).into_response());
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"));
    response
}
fn login_page(status: StatusCode) -> Response {
    let mut response = local((status, Html(include_str!("login.html"))).into_response());
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"));
    response
}

#[cfg(test)]
mod tests;
