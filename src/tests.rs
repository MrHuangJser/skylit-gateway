use super::*;
use http_body_util::BodyExt;
use tokio::task::JoinHandle;
use tower::ServiceExt;

// This is a synthetic fixture, not an upstream credential.
const TEST_TOKEN: &str = "test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdef";
const ORIGIN: &str = "https://gateway.example.test";

#[derive(Clone)]
struct Captured { method: Method, uri: String, headers: HeaderMap, body: Vec<u8> }
/// A scripted upstream reply: status, headers and body chunks.
type Reply = (StatusCode, HeaderMap, Vec<Vec<u8>>);
struct MockState {
    requests: Mutex<Vec<Captured>>,
    access: Mutex<Option<(StatusCode, Vec<Vec<u8>>)>>,
    replies: Mutex<HashMap<String, Reply>>,
}
struct Fixture {
    app: Router,
    gateway: Arc<Gateway>,
    mock: Arc<MockState>,
    task: JoinHandle<()>,
}
impl Drop for Fixture { fn drop(&mut self) { self.task.abort(); } }

fn config() -> Config {
    Config { access_hash: hash(TEST_TOKEN.as_bytes()), public_origin: ORIGIN.into(), cookie_secure: true, session_file: None,
        enable_browser_auth_adapter: false, enable_frontend_auth_rewrite: false, enable_open_device_access: false,
        device_state_dir: None,
        // Tests exercise the live path; the snapshot tests point at their own directory.
        frontend_mirror_dir: "tests/no-snapshot-here".into() }
}

async fn fixture() -> Fixture { fixture_with_config(config()).await }

async fn fixture_with_config(config: Config) -> Fixture {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mock = Arc::new(MockState { requests: Mutex::new(Vec::new()), access: Mutex::new(None), replies: Mutex::new(HashMap::new()) });
    let mock_app = Router::new().fallback(mock_handler).with_state(mock.clone());
    let task = tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap(); });
    let mut gateway = Gateway::new(config).unwrap();
    // The only upstream override is here, in cfg(test); no environment/config override exists.
    gateway.upstream = Url::parse(&format!("http://{address}")).unwrap();
    let gateway = Arc::new(gateway);
    Fixture { app: router_with_state(gateway.clone()), gateway, mock, task }
}

async fn mock_handler(State(state): State<Arc<MockState>>, request: Request) -> Response {
    let (parts, incoming) = request.into_parts();
    let bytes = to_bytes(incoming, MAX_LOGIN_BODY).await.unwrap();
    let request = Request::from_parts(parts, Body::empty());
    state.requests.lock().unwrap().push(Captured {
        method: request.method().clone(), uri: request.uri().to_string(), headers: request.headers().clone(), body: bytes.to_vec(),
    });
    if let Some((status, headers, chunks)) = state.replies.lock().unwrap().get(request.uri().path()).cloned() {
        let chunks = chunks.into_iter().map(|chunk| Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk)));
        let mut response = Response::new(Body::from_stream(futures_util::stream::iter(chunks)));
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        return response;
    }
    if request.uri().path() == "/api/access" {
        if let Some((status, chunks)) = state.access.lock().unwrap().clone() {
            let chunks = chunks.into_iter().map(|chunk| Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk)));
            let mut response = Response::new(Body::from_stream(futures_util::stream::iter(chunks)));
            *response.status_mut() = status;
            response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("upstream_secret=synthetic"));
            response.headers_mut().insert("access-control-allow-origin", HeaderValue::from_static("*"));
            return response;
        }
    }
    match request.uri().path() {
        "/redirect/local" => (StatusCode::FOUND, [(header::LOCATION, "/destination?q=1#part")], "").into_response(),
        "/redirect/absolute" => {
            let host = request.headers().get(header::HOST).unwrap().to_str().unwrap();
            (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, format!("http://{host}/destination"))], "").into_response()
        }
        "/redirect/external" => (StatusCode::FOUND, [(header::LOCATION, "https://external.invalid/collect")], "").into_response(),
        "/redirect/double" => {
            let host = request.headers().get(header::HOST).unwrap().to_str().unwrap();
            (StatusCode::FOUND, [(header::LOCATION, format!("http://{host}//external.invalid/path"))], "").into_response()
        }
        "/stream" => {
            use futures_util::{stream, StreamExt};
            let first = stream::once(async {
                Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"data: transport-only\n\n"))
            });
            // The body never finishes. A buffering gateway would never return its first event.
            let mut response = Response::new(Body::from_stream(first.chain(stream::pending())));
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
            response
        },
        _ => {
            let mut response = "mock-upstream".into_response();
            response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("upstream_secret=not-real"));
            response.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("keep-alive, x-upstream-hop"));
            response.headers_mut().insert("x-upstream-hop", HeaderValue::from_static("remove-me"));
            response.headers_mut().insert("refresh", HeaderValue::from_static("0;url=https://external.invalid"));
            response
        }
    }
}

fn authorized_request(method: Method, uri: &str) -> Request {
    Request::builder().method(method).uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TEST_TOKEN}"))
        .body(Body::empty()).unwrap()
}
async fn body(response: Response) -> String {
    String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}
fn login_request(token: &str, origin: Option<&str>) -> Request {
    let mut request = Request::builder().method(Method::POST).uri("/_gateway/login")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(origin) = origin { request = request.header(header::ORIGIN, origin); }
    request.body(Body::from(format!(r#"{{"accessToken":"{token}"}}"#))).unwrap()
}

#[tokio::test]
async fn missing_credentials_only_returns_local_login_and_never_hits_upstream() {
    let f = fixture().await;
    let response = f.app.clone().oneshot(Request::builder().uri("/private").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get(header::LOCATION).is_none());
    let html = body(response).await;
    assert!(html.contains("transport-only"));
    assert!(!html.contains("mock-upstream"));
    assert!(!html.contains("https://app.skylit.ai"));
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn wrong_bearer_and_wrong_access_code_are_rejected_without_upstream() {
    let f = fixture().await;
    let request = Request::builder().uri("/").header(header::AUTHORIZATION, "Bearer incorrect")
        .body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let response = f.app.clone().oneshot(login_request("incorrect", Some(ORIGIN))).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn health_exposes_only_transport_status_without_secrets_or_upstream_request() {
    let f = fixture().await;
    let request = Request::builder().uri("/_gateway/health").body(Body::empty()).unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let value = body(response).await;
    assert_eq!(value, r#"{"status":"ok","phase":"transport-only","upstreamSession":false}"#);
    assert!(!value.contains(TEST_TOKEN));
    assert!(!value.contains(ORIGIN));
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn login_requires_explicit_same_origin_and_has_bounded_json_body() {
    let f = fixture().await;
    for origin in [None, Some("null"), Some("https://evil.invalid"), Some("https://gateway.example.test.evil.invalid")] {
        let response = f.app.clone().oneshot(login_request(TEST_TOKEN, origin)).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
    }
    let response = f.app.clone().oneshot(login_request(&"x".repeat(MAX_LOGIN_BODY + 1), Some(ORIGIN))).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn random_local_sessions_work_and_logout_only_revokes_that_session() {
    let f = fixture().await;
    let response = f.app.clone().oneshot(login_request(TEST_TOKEN, Some(ORIGIN))).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let set_cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().to_owned();
    for attribute in ["__Host-skylit_gateway=", "HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=28800"] {
        assert!(set_cookie.contains(attribute));
    }
    let cookie = set_cookie.split(';').next().unwrap();
    let second = f.app.clone().oneshot(login_request(TEST_TOKEN, Some(ORIGIN))).await.unwrap();
    let second_cookie = second.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    assert_ne!(cookie, second_cookie);
    let request = Request::builder().uri("/echo").header(header::COOKIE, cookie).body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::OK);
    assert!(f.mock.requests.lock().unwrap()[0].headers.get(header::COOKIE).is_none());
    let logout = Request::builder().method(Method::POST).uri("/_gateway/logout")
        .header(header::COOKIE, cookie).header(header::ORIGIN, ORIGIN).body(Body::empty()).unwrap();
    let response = f.app.clone().oneshot(logout).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(response.headers()[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));
    let request = Request::builder().uri("/echo").header(header::COOKIE, cookie).body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let request = Request::builder().uri("/echo").header(header::COOKIE, second_cookie).body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::OK);
    assert_eq!(f.mock.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn sensitive_and_hop_headers_are_filtered_both_directions() {
    let f = fixture().await;
    let mut request = authorized_request(Method::GET, "/echo?value=1");
    let headers = request.headers_mut();
    headers.insert(header::COOKIE, HeaderValue::from_static("private=not-a-real-secret"));
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://untrusted.invalid"));
    headers.insert("x-forwarded-for", HeaderValue::from_static("127.0.0.1"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("accept-language, x-request-hop"));
    headers.insert(header::ACCEPT_LANGUAGE, HeaderValue::from_static("sensitive-nomination"));
    headers.insert("x-request-hop", HeaderValue::from_static("remove-me"));
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for name in ["set-cookie", "connection", "x-upstream-hop", "refresh"] {
        assert!(response.headers().get(name).is_none(), "unexpected response header {name}");
    }
    assert_eq!(body(response).await, "mock-upstream");
    let captured = f.mock.requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].uri, "/echo?value=1");
    assert_eq!(captured[0].method, Method::GET);
    for name in ["authorization", "cookie", "origin", "x-forwarded-for", "accept-language", "connection", "x-request-hop"] {
        assert!(captured[0].headers.get(name).is_none(), "unexpected request header {name}");
    }
    assert_eq!(captured[0].headers[header::ACCEPT], "application/json");
}

#[tokio::test]
async fn mutations_are_forbidden_even_with_valid_local_credentials() {
    let f = fixture().await;
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS, Method::TRACE, Method::CONNECT] {
        let response = f.app.clone().oneshot(authorized_request(method, "/write")).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn redirects_are_not_followed_and_only_same_origin_locations_are_rewritten() {
    let f = fixture().await;
    for (path, expected) in [("/redirect/local", "/destination?q=1#part"), ("/redirect/absolute", "/destination")] {
        let response = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        assert!(response.status().is_redirection());
        assert_eq!(response.headers()[header::LOCATION], expected);
    }
    for path in ["/redirect/external", "/redirect/double"] {
        let response = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(response.headers().get(header::LOCATION).is_none());
    }
    let captured = f.mock.requests.lock().unwrap();
    assert_eq!(captured.len(), 4); // No follow-up request to /destination or any external site.
}

#[tokio::test]
async fn request_authority_cannot_override_fixed_target_and_stream_is_not_collected() {
    assert_eq!(Gateway::new(config()).unwrap().upstream.as_str(), "https://app.skylit.ai/");
    let f = fixture().await;
    let request = authorized_request(Method::GET, "http://attacker.invalid/stream?x=1");
    let response = tokio::time::timeout(Duration::from_secs(3), f.app.clone().oneshot(request))
        .await.expect("stream headers must not wait for EOF").unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    let mut stream_body = response.into_body();
    let frame = tokio::time::timeout(Duration::from_secs(3), stream_body.frame())
        .await.expect("first SSE frame must arrive before EOF").unwrap().unwrap();
    assert_eq!(frame.into_data().unwrap().as_ref(), b"data: transport-only\n\n");
    assert!(tokio::time::timeout(Duration::from_millis(30), stream_body.frame()).await.is_err());
    let captured = f.mock.requests.lock().unwrap();
    assert_eq!(captured[0].uri, "/stream?x=1");
    assert_ne!(captured[0].headers[header::HOST], "attacker.invalid");
}

#[tokio::test]
async fn expired_sessions_fail_closed_and_development_cookies_are_explicit() {
    let f = fixture().await;
    let secret = [7u8; 32];
    f.gateway.sessions.lock().unwrap().insert(hash(&secret), Instant::now() - Duration::from_secs(1));
    let request = Request::builder().uri("/")
        .header(header::COOKIE, format!("__Host-skylit_gateway={}", hex::encode(secret)))
        .body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let mut dev = config();
    dev.cookie_secure = false;
    let gateway = Gateway::new(dev).unwrap();
    let cookie = gateway.cookie("test", 1);
    assert!(cookie.starts_with("skylit_gateway="));
    assert!(!cookie.contains("; Secure"));
    assert!(cookie.contains("HttpOnly; SameSite=Strict"));
}

// All disk fixtures contain only synthetic credentials, never a captured session.
const UPSTREAM_TEST_TOKEN: &str = "synthetic_header.synthetic_payload.synthetic_signature";
struct SessionFile { directory: std::path::PathBuf, path: std::path::PathBuf }
impl SessionFile {
    fn new(contents: Option<&str>) -> Self {
        let mut id = [0u8; 16];
        OsRng.fill_bytes(&mut id);
        let root = std::env::temp_dir();
        let directory = root.join(format!("skylit-gateway-session-test-{}", hex::encode(id)));
        assert_eq!(directory.parent(), Some(root.as_path()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("snapshot.json");
        if let Some(contents) = contents { std::fs::write(&path, contents).unwrap(); }
        Self { directory, path }
    }
    fn config(&self) -> Config {
        let mut value = config();
        value.session_file = Some(self.path.clone());
        value
    }
}
impl Drop for SessionFile {
    fn drop(&mut self) {
        // Verify the exact deletion target; never recursively remove a computed temp root.
        assert_eq!(self.directory.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self.directory.file_name().unwrap().to_str().unwrap().starts_with("skylit-gateway-session-test-"));
        assert_eq!(self.path, self.directory.join("snapshot.json"));
        match std::fs::remove_file(&self.path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => panic!("synthetic session cleanup failed: {error}"),
        }
        let profile = self.path.with_file_name("browser-profile.json");
        assert_eq!(profile, self.directory.join("browser-profile.json"));
        match std::fs::remove_file(profile) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => panic!("synthetic profile cleanup failed"),
        }
        std::fs::remove_dir(&self.directory).unwrap();
    }
}
fn epoch_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}
fn snapshot(token: &str, captured: u64, expires: u64) -> String {
    serde_json::json!({"bearerToken":token,"capturedAt":captured,"expiresAt":expires}).to_string()
}

#[tokio::test]
async fn session_snapshot_overrides_only_supported_reads_and_never_returns_upstream_cookie() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(file.config()).await;
    for method in [Method::GET, Method::HEAD] {
        for path in ["/api/access", "/api/access/entitlements?probe=1", "/tv/search?query=SPY&limit=1", "/tv/history?symbol=SPY"] {
            let mut request = authorized_request(method.clone(), path);
            request.headers_mut().insert(header::COOKIE, HeaderValue::from_static("upstream_cookie=synthetic"));
            let response = f.app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get(header::SET_COOKIE).is_none());
        }
    }
    let captured = f.mock.requests.lock().unwrap();
    assert_eq!(captured.len(), 8);
    for request in captured.iter() {
        assert_eq!(request.headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
        assert!(request.headers.get(header::COOKIE).is_none());
        assert_ne!(request.headers[header::AUTHORIZATION], format!("Bearer {TEST_TOKEN}"));
    }
}

#[tokio::test]
async fn invalid_missing_or_stale_snapshots_fail_closed_before_mock_request() {
    let now = epoch_now();
    let invalid = vec![
        None,
        Some("not JSON".into()),
        Some("x".repeat(16 * 1024 + 1)),
        Some(snapshot(UPSTREAM_TEST_TOKEN, now - 60, now - 1)),
        Some(snapshot(UPSTREAM_TEST_TOKEN, now, now + 3)),
        Some(snapshot(UPSTREAM_TEST_TOKEN, now - 121, now + 60)),
        Some(snapshot(UPSTREAM_TEST_TOKEN, now + 60, now + 180)),
        Some(snapshot(UPSTREAM_TEST_TOKEN, now, now + 301)),
        Some(snapshot(UPSTREAM_TEST_TOKEN, now + 20, now + 10)),
        Some(snapshot("one.two", now, now + 60)),
        Some(snapshot("one..three", now, now + 60)),
        Some(snapshot("one.two.three.four", now, now + 60)),
        Some(snapshot("one.two.bad token", now, now + 60)),
        Some(snapshot("one.two.非ASCII", now, now + 60)),
        Some(snapshot(&format!("one.two.{}", "a".repeat(8192)), now, now + 60)),
        Some(format!(r#"{{"bearerToken":"{UPSTREAM_TEST_TOKEN}","expiresAt":-1,"capturedAt":{now}}}"#)),
        Some(format!(r#"{{"bearerToken":"{UPSTREAM_TEST_TOKEN}","expiresAt":{},"capturedAt":"{now}"}}"#, now + 60)),
    ];
    for contents in invalid {
        let file = SessionFile::new(contents.as_deref());
        let f = fixture_with_config(file.config()).await;
        for method in [Method::GET, Method::HEAD] {
            for path in SESSION_PATHS {
                let response = f.app.clone().oneshot(authorized_request(method.clone(), path)).await.unwrap();
                assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
                if method == Method::GET {
                    assert_eq!(body(response).await, "Upstream session unavailable");
                }
            }
        }
        assert!(f.mock.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn session_is_not_used_on_other_paths_or_without_local_authentication() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(file.config()).await;
    for method in [Method::GET, Method::HEAD] {
        for path in ["/", "/atlas", "/other.html", "/atlas/", "/atlas/extra", "/atlas-extra", "/Atlas", "/%61tlas", "/api/access/", "/api/access/entitlements/extra", "/api/%61ccess", "/api/access-extra", "/tv/history/", "/tv/search/extra", "/api/symbols", "/tv/presets", "/api/nexus/support/tickets", "/agent-gateway/agenthub/tempest/access", "/api/data", "/api/data/range"] {
            let response = f.app.clone().oneshot(authorized_request(method.clone(), path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
    for request in f.mock.requests.lock().unwrap().iter() {
        assert!(request.headers.get(header::AUTHORIZATION).is_none());
    }
    let previous = f.mock.requests.lock().unwrap().len();
    for method in [Method::GET, Method::HEAD] {
        for path in ["/", "/atlas", "/api/access", "/api/access/entitlements", "/_gateway/capabilities"] {
            let request = Request::builder().method(method.clone()).uri(path).body(Body::empty()).unwrap();
            assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
    }
    assert_eq!(f.mock.requests.lock().unwrap().len(), previous);
    for path in ["/", "/atlas", "/api/access"] {
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS, Method::TRACE, Method::CONNECT] {
            let response = f.app.clone().oneshot(authorized_request(method, path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }
    assert_eq!(f.mock.requests.lock().unwrap().len(), previous);
}

#[tokio::test]
async fn health_and_authenticated_capabilities_do_not_load_or_disclose_session() {
    // A nonexistent file still permits both local status probes, without claiming login validity.
    let file = SessionFile::new(None);
    let f = fixture_with_config(file.config()).await;
    let request = Request::builder().uri("/_gateway/health").body(Body::empty()).unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, r#"{"status":"ok","phase":"session-adapter-probe","upstreamSession":false}"#);
    let response = f.app.clone().oneshot(authorized_request(Method::GET, "/_gateway/capabilities")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let text = body(response).await;
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["supportedPaths"], serde_json::json!(["/api/access", "/api/access/entitlements", "/tv/search", "/tv/history"]));
    assert_eq!(value["supportedMethods"], serde_json::json!(["GET", "HEAD"]));
    assert_eq!(value["fullWebsiteReady"], false);
    for secret in [TEST_TOKEN, UPSTREAM_TEST_TOKEN, file.path.to_str().unwrap(), ORIGIN] {
        assert!(!text.contains(secret));
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn session_is_reloaded_bounded_and_not_required_for_other_paths() {
    let now = epoch_now();
    let token = format!("a.b.{}", "x".repeat(8188)); // Exactly 8192 token bytes.
    let mut contents = snapshot(&token, now, now + 180);
    contents.push_str(&" ".repeat(16 * 1024 - contents.len())); // Exactly 16 KiB JSON.
    let file = SessionFile::new(Some(&contents));
    let f = fixture_with_config(file.config()).await;
    let response = f.app.clone().oneshot(authorized_request(Method::GET, "/api/access")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(f.mock.requests.lock().unwrap()[0].headers[header::AUTHORIZATION], format!("Bearer {token}"));
    // A later missing file must invalidate the previous credential, rather than cache it.
    assert_eq!(file.path, file.directory.join("snapshot.json"));
    std::fs::remove_file(&file.path).unwrap();
    let response = f.app.clone().oneshot(authorized_request(Method::GET, "/api/access")).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
    let response = f.app.clone().oneshot(authorized_request(Method::GET, "/unrelated")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let requests = f.mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].headers.get(header::AUTHORIZATION).is_none());
}

#[tokio::test]
async fn unconfigured_session_keeps_supported_paths_transport_only() {
    let f = fixture().await;
    for path in ["/api/access", "/api/access/entitlements"] {
        let response = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let requests = f.mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.headers.get(header::AUTHORIZATION).is_none()));
}

#[tokio::test]
async fn browser_vendor_bearer_requires_local_cookie_and_never_becomes_gateway_identity() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(browser_config(&file)).await;
    let login = f.app.clone().oneshot(login_request(TEST_TOKEN, Some(ORIGIN))).await.unwrap();
    let cookie = login.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let incoming = "Bearer client.supplied.jwt";
    let request = Request::builder().uri("/api/access")
        .header(header::COOKIE, &cookie).header(header::AUTHORIZATION, incoming)
        .body(Body::empty()).unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    {
        let captured = f.mock.requests.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
        assert_ne!(captured[0].headers[header::AUTHORIZATION], incoming);
    }
    let no_local_identity = Request::builder().uri("/api/access")
        .header(header::AUTHORIZATION, incoming).body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(no_local_identity).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
}

fn bootstrap_request() -> Request {
    let mut request = authorized_request(Method::POST, "/_gateway/auth/bootstrap?url=https://attacker.invalid");
    request.headers_mut().insert(header::ORIGIN, HeaderValue::from_static(ORIGIN));
    request.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    request.headers_mut().insert(header::COOKIE, HeaderValue::from_static("upstream_cookie=must-not-leave"));
    request
}

fn browser_config(file: &SessionFile) -> Config {
    let mut config = file.config();
    config.enable_browser_auth_adapter = true;
    config
}

#[test]
fn browser_auth_flag_is_strict_and_defaults_off() {
    assert!(!browser_auth_enabled(Err(env::VarError::NotPresent)).unwrap());
    assert!(!browser_auth_enabled(Ok("false".into())).unwrap());
    assert!(browser_auth_enabled(Ok("true".into())).unwrap());
    for value in ["", "TRUE", "False", "1", " true", "false "] {
        assert!(browser_auth_enabled(Ok(value.into())).is_err());
    }
    assert!(browser_auth_enabled(Err(env::VarError::NotUnicode(std::ffi::OsString::new()))).is_err());
    assert!(!config().enable_browser_auth_adapter);
    assert!(config().session_file.is_none());
}

#[tokio::test]
async fn browser_bootstrap_defaults_404_and_requires_auth_origin_json_and_post() {
    let f = fixture().await;
    assert_eq!(f.app.clone().oneshot(bootstrap_request()).await.unwrap().status(), StatusCode::NOT_FOUND);
    let mut request = bootstrap_request();
    request.headers_mut().remove(header::AUTHORIZATION);
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::NOT_FOUND);
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(browser_config(&file)).await;
    let mut request = bootstrap_request();
    request.headers_mut().remove(header::AUTHORIZATION);
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for origin in [None, Some("null"), Some("https://evil.invalid")] {
        let mut request = bootstrap_request();
        request.headers_mut().remove(header::ORIGIN);
        if let Some(origin) = origin { request.headers_mut().insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap()); }
        assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    let mut request = bootstrap_request();
    request.headers_mut().append(header::ORIGIN, HeaderValue::from_static(ORIGIN));
    assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::FORBIDDEN);
    for content_type in [None, Some("text/plain")] {
        let mut request = bootstrap_request();
        request.headers_mut().remove(header::CONTENT_TYPE);
        if let Some(value) = content_type { request.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(value)); }
        assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    for method in [Method::GET, Method::HEAD, Method::OPTIONS] {
        let mut request = bootstrap_request();
        *request.method_mut() = method;
        assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

// Explicit synthetic normal-SDK profile, never a default manufactured user.
fn synthetic_profile(now: u64) -> serde_json::Value {
    serde_json::json!({
        "source":"normal-clerk-session", "capturedAt":now,
        "user": {
            "id":"user_fixture_real_42", "firstName":"Synthetic", "lastName":null,
            "fullName":"Synthetic", "username":null, "imageUrl":null,
            "createdAt":"2026-01-01T00:00:00.000Z", "updatedAt":null,
            "publicMetadata":{"fixture":true}, "organizationMemberships":[],
            "primaryEmailAddressId":"email_fixture", "emailAddresses":[{"id":"email_fixture", "emailAddress":"fixture@example.test"}]
        },
        "session":{"id":"sess_fixture", "status":"active", "actor":null,
            "expireAt":"2026-12-01T00:00:00.000Z", "lastActiveAt":null},
        "organization":null
    })
}
fn write_profile(file: &SessionFile, profile: &serde_json::Value) {
    let path = file.path.with_file_name("browser-profile.json");
    assert_eq!(path, file.directory.join("browser-profile.json"));
    std::fs::write(path, profile.to_string()).unwrap();
}

#[tokio::test]
async fn browser_bootstrap_returns_only_real_upstream_identity_and_snapshot_token() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let profile = synthetic_profile(now);
    write_profile(&file, &profile);
    let f = fixture_with_config(browser_config(&file)).await;
    *f.mock.access.lock().unwrap() = Some((StatusCode::OK, vec![br#"{"user_id":"user_fixture_real_42","application":true,"roles":["ignored"]}"#.to_vec()]));
    let response = f.app.clone().oneshot(bootstrap_request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    for name in ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials"] {
        assert!(response.headers().get(name).is_none());
    }
    let value: serde_json::Value = serde_json::from_str(&body(response).await).unwrap();
    assert_eq!(value, serde_json::json!({
        "source":"upstream-verified", "user":profile["user"],
        "session":profile["session"], "organization":profile["organization"],
        "profileComplete":true, "userSource":"normal-clerk-session",
        "token":UPSTREAM_TEST_TOKEN,"expiresAt":now+180,"fullWebsiteReady":false
    }));
    {
        let captured = f.mock.requests.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].uri, "/api/access");
        assert_eq!(captured[0].method, Method::GET);
        assert_eq!(captured[0].headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
        assert_ne!(captured[0].headers[header::AUTHORIZATION], format!("Bearer {TEST_TOKEN}"));
        for name in ["cookie", "origin", "referer"] { assert!(captured[0].headers.get(name).is_none()); }
    }
    // Enabling bootstrap does not authenticate the UI root or widen the four-path adapter.
    assert_eq!(SESSION_PATHS, ["/api/access", "/api/access/entitlements", "/tv/search", "/tv/history"]);
    let response = f.app.clone().oneshot(authorized_request(Method::GET, "/")).await.unwrap();
    assert_eq!(body(response).await, "mock-upstream");
    assert!(f.mock.requests.lock().unwrap()[1].headers.get(header::AUTHORIZATION).is_none());
}

#[tokio::test]
async fn browser_bootstrap_invalid_snapshots_fail_closed_without_upstream() {
    for contents in [None, Some("invalid JSON")] {
        let file = SessionFile::new(contents);
        let f = fixture_with_config(browser_config(&file)).await;
        let response = f.app.clone().oneshot(bootstrap_request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body(response).await, "Upstream session unavailable");
        assert!(f.mock.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn browser_bootstrap_verification_failures_are_closed_and_local_session_survives() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(browser_config(&file)).await;
    let login = f.app.clone().oneshot(login_request(TEST_TOKEN, Some(ORIGIN))).await.unwrap();
    let cookie = login.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let mut cases = vec![
        (StatusCode::UNAUTHORIZED, vec![b"unauthorized".to_vec()]),
        (StatusCode::FORBIDDEN, vec![b"forbidden".to_vec()]),
        (StatusCode::FOUND, vec![]),
    ];
    for json in [
        r#"{"user_id":"real","application":false}"#, r#"{"application":true}"#,
        r#"{"user_id":"","application":true}"#, r#"{"user_id":"  ","application":true}"#,
        r#"{"user_id":123,"application":true}"#, r#"{"user_id":"real","application":"true"}"#,
        "not JSON", "{", "null",
    ] { cases.push((StatusCode::OK, vec![json.as_bytes().to_vec()])); }
    // Chunked bodies have no Content-Length; enforce the cumulative cap, not just individual chunks.
    cases.push((StatusCode::OK, vec![vec![b' '; MAX_ACCESS_BODY / 2], vec![b' '; MAX_ACCESS_BODY / 2 + 1]]));
    for case in cases {
        *f.mock.access.lock().unwrap() = Some(case);
        let mut request = bootstrap_request();
        request.headers_mut().remove(header::AUTHORIZATION);
        request.headers_mut().insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        let response = f.app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(body(response).await, "Upstream verification unavailable");
        let request = Request::builder().uri("/_gateway/capabilities").header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
        assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn browser_profile_missing_invalid_stale_and_wrong_identity_fail_closed() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(browser_config(&file)).await;
    *f.mock.access.lock().unwrap() = Some((StatusCode::OK, vec![br#"{"user_id":"user_fixture_real_42","application":true}"#.to_vec()]));
    let response = f.app.clone().oneshot(bootstrap_request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body(response).await, "Browser profile unavailable");
    let base = synthetic_profile(now);
    let mut invalid = Vec::new();
    // Margins clear of the 120s/30s limits: a clock tick during the test must not
    // turn a deliberately invalid timestamp into a valid one.
    for (key, value) in [("source", serde_json::json!("other")), ("capturedAt", serde_json::json!(now - 135)), ("capturedAt", serde_json::json!(now + 45))] {
        let mut p = base.clone(); p[key] = value; invalid.push(p);
    }
    for (key, value) in [("id", serde_json::json!("wrong_user")), ("publicMetadata", serde_json::Value::Null), ("organizationMemberships", serde_json::Value::Null), ("emailAddresses", serde_json::Value::Null)] {
        let mut p = base.clone(); p["user"][key] = value; invalid.push(p);
    }
    for (key, value) in [("id", serde_json::json!("")), ("status", serde_json::json!("ended")), ("actor", serde_json::json!("not-a-resource"))] {
        let mut p = base.clone(); p["session"][key] = value; invalid.push(p);
    }
    let mut missing = base.clone(); missing["user"].as_object_mut().unwrap().remove("publicMetadata"); invalid.push(missing);
    let mut missing = base.clone(); missing["user"].as_object_mut().unwrap().remove("organizationMemberships"); invalid.push(missing);
    invalid.push(serde_json::json!({}));
    for p in invalid {
        write_profile(&file, &p);
        let response = f.app.clone().oneshot(bootstrap_request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body(response).await, "Browser profile unavailable");
    }
    let profile_path = file.path.with_file_name("browser-profile.json");
    for bytes in [b"not JSON".to_vec(), vec![b' '; 64 * 1024 + 1]] {
        std::fs::write(&profile_path, bytes).unwrap();
        assert_eq!(f.app.clone().oneshot(bootstrap_request()).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}

#[tokio::test]
async fn browser_profile_projects_nested_allowlists_and_reloads_at_exact_size_bound() {
    let now = epoch_now();
    let file = SessionFile::new(None);
    let mut p = synthetic_profile(now);
    let org = serde_json::json!({"id":"org_fixture", "name":"Synthetic Org", "slug":null, "imageUrl":null, "publicMetadata":{}, "token":"must-not-export"});
    p["organization"] = org.clone();
    p["user"]["organizationMemberships"] = serde_json::json!([{"id":"membership_fixture", "role":"org:member", "organization":org, "token":"must-not-export"}]);
    p["session"]["actor"] = serde_json::json!({"sub":"actor_fixture", "iss":"issuer_fixture", "sid":"sid_fixture", "token":"must-not-export"});
    p["user"]["token"] = serde_json::json!("must-not-export");
    p["user"]["emailAddresses"][0]["verification"] = serde_json::json!({"token":"must-not-export"});
    p["session"]["token"] = serde_json::json!("must-not-export");
    p["token"] = serde_json::json!("must-not-export");
    let mut bytes = p.to_string();
    bytes.push_str(&" ".repeat(64 * 1024 - bytes.len()));
    std::fs::write(file.path.with_file_name("browser-profile.json"), bytes).unwrap();
    let profile = match profile::BrowserProfile::load(&file.path, "user_fixture_real_42").await { Ok(p) => p, Err(_) => panic!("valid synthetic profile rejected") };
    assert!(!profile.user.to_string().contains("must-not-export"));
    assert!(!profile.session.to_string().contains("must-not-export"));
    assert!(!profile.organization.to_string().contains("must-not-export"));
    assert_eq!(profile.session["actor"], serde_json::json!({"sub":"actor_fixture", "iss":"issuer_fixture", "sid":"sid_fixture"}));
    assert_eq!(profile.user["organizationMemberships"][0]["role"], "org:member");
    // Real empty memberships remain a valid empty array, without synthesized roles.
    write_profile(&file, &synthetic_profile(now));
    assert!(profile::BrowserProfile::load(&file.path, "user_fixture_real_42").await.is_ok());
    write_profile(&file, &synthetic_profile(now - 121));
    assert!(profile::BrowserProfile::load(&file.path, "user_fixture_real_42").await.is_err());
}

#[test]
fn frontend_rewrite_flag_is_strict_default_off_and_requires_adapter_and_session() {
    assert!(!frontend_auth_rewrite_enabled(Err(env::VarError::NotPresent)).unwrap());
    assert!(!frontend_auth_rewrite_enabled(Ok("false".into())).unwrap());
    assert!(frontend_auth_rewrite_enabled(Ok("true".into())).unwrap());
    for value in ["", "TRUE", "False", "1", " true", "false "] { assert!(frontend_auth_rewrite_enabled(Ok(value.into())).is_err()); }
    assert!(frontend_auth_rewrite_enabled(Err(env::VarError::NotUnicode(std::ffi::OsString::new()))).is_err());
    let path = std::path::Path::new("synthetic.json");
    assert!(validate_frontend_auth_rewrite(true, true, Some(path)).is_ok());
    assert!(validate_frontend_auth_rewrite(true, false, Some(path)).is_err());
    assert!(validate_frontend_auth_rewrite(true, true, None).is_err());
    assert!(validate_frontend_auth_rewrite(true, true, Some(std::path::Path::new(""))).is_err());
    assert!(validate_frontend_auth_rewrite(false, false, None).is_ok());
    assert!(!config().enable_frontend_auth_rewrite);
}

#[tokio::test]
async fn frontend_rewrite_only_adds_exact_read_paths_for_snapshot_bearer() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let mut config = browser_config(&file);
    config.enable_frontend_auth_rewrite = true;
    let f = fixture_with_config(config).await;
    for method in [Method::GET, Method::HEAD] {
        for path in ["/heatmaps", "/atlas?fixture=1", "/api/nexus/legal/terms-status", "/api/symbols", "/api/nexus/support/tickets", "/agent-gateway/agenthub/tempest/access"] {
            assert_eq!(f.app.clone().oneshot(authorized_request(method.clone(), path)).await.unwrap().status(), StatusCode::OK);
        }
        // Presets are per-device state now. A bare access-code Bearer has no device
        // identity, so it is refused instead of sharing one global state bucket...
        assert_eq!(f.app.clone().oneshot(authorized_request(method.clone(), "/tv/presets")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        // ...while a browser with its own device cookie is answered locally.
        let login = f.app.clone().oneshot(login_request(TEST_TOKEN, Some(ORIGIN))).await.unwrap();
        let cookie = login.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
        let r = Request::builder().method(method.clone()).uri("/tv/presets").header(header::COOKIE, cookie).body(Body::empty()).unwrap();
        assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::OK);
    }
    {
        let requests = f.mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 12);
        assert!(requests.iter().all(|r| r.uri != "/tv/presets"));
        assert!(requests.iter().all(|r| r.headers[header::AUTHORIZATION] == format!("Bearer {UPSTREAM_TEST_TOKEN}")));
    }
    // Any other app page or read API is rendered with the normal token too (an exact
    // allowlist left real pages anonymous, which broke them)...
    for path in ["/talon", "/portal", "/fs/api/alerts", "/api/stages/recaps"] {
        assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap().status(), StatusCode::OK);
    }
    assert!(f.mock.requests.lock().unwrap()[12..].iter().all(|r| r.headers[header::AUTHORIZATION] == format!("Bearer {UPSTREAM_TEST_TOKEN}")));
    // ...but public build assets never carry it.
    let prior = f.mock.requests.lock().unwrap().len();
    assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, "/_next/static/chunks/public.js")).await.unwrap().status(), StatusCode::OK);
    assert!(!f.mock.requests.lock().unwrap()[prior].headers.contains_key(header::AUTHORIZATION));
    for path in ["/", "/atlas", "/api/nexus/legal/terms-status"] {
        assert_eq!(f.app.clone().oneshot(authorized_request(Method::POST, path)).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    // Enabling frontend rewriting still fails closed if its normal snapshot disappears.
    std::fs::remove_file(&file.path).unwrap();
    for path in [HOME_ROUTE, "/atlas", "/api/nexus/legal/terms-status"] {
        assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}

fn edge_config(file: &SessionFile) -> Config {
    let mut config = browser_config(file);
    config.enable_frontend_auth_rewrite = true;
    config
}
fn capability_request(path: &str, bytes: impl Into<Body>) -> Request {
    Request::builder().method(Method::POST).uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {TEST_TOKEN}"))
        .header(header::ORIGIN, ORIGIN).header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, "CloudFront-Policy=visitor-must-not-leave")
        .body(bytes.into()).unwrap()
}
fn grant_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    for name in ["CloudFront-Key-Pair-Id", "CloudFront-Policy", "CloudFront-Signature"] {
        headers.append(header::SET_COOKIE, HeaderValue::from_str(&format!("{name}=synthetic-{name}; Path=/api/data; Max-Age=14400; HttpOnly; Secure; SameSite=Lax")).unwrap());
    }
    headers
}
fn grant_reply(f: &Fixture, headers: HeaderMap, value: serde_json::Value) {
    *f.mock.access.lock().unwrap() = Some((StatusCode::OK, vec![br#"{"user_id":"user_fixture_real_42","application":true}"#.to_vec()]));
    f.mock.replies.lock().unwrap().insert("/api/edge/cookies".into(), (StatusCode::OK, headers, vec![value.to_string().into_bytes()]));
}
fn parse_lease(headers: &HeaderMap, ttl: u64) -> Result<edge::CookieLease, edge::Unavailable> {
    edge::CookieLease::parse(headers, "user_fixture_real_42".into(), ttl, Instant::now())
}

#[test]
fn edge_cookie_parser_rejects_missing_duplicate_path_age_domain_and_controls() {
    let valid = grant_headers();
    assert!(parse_lease(&valid, 14400).is_ok());
    for ttl in [0, 14401, u64::MAX] { assert!(parse_lease(&valid, ttl).is_err()); }
    let lines: Vec<_> = valid.get_all(header::SET_COOKIE).iter().map(|v| v.to_str().unwrap().to_owned()).collect();
    let mut missing = valid.clone(); missing.remove(header::SET_COOKIE);
    for line in &lines[..2] { missing.append(header::SET_COOKIE, HeaderValue::from_str(line).unwrap()); }
    assert!(parse_lease(&missing, 14400).is_err());
    let mut duplicate = valid.clone(); duplicate.append(header::SET_COOKIE, valid[header::SET_COOKIE].clone());
    assert!(parse_lease(&duplicate, 14400).is_err());
    for bad in [
        lines[0].replace("Path=/api/data", "Path=/api"),
        lines[0].replace("Path=/api/data", "Path=/api/data/range"),
        lines[0].replace("Max-Age=14400", "Max-Age=0"),
        lines[0].replace("Max-Age=14400", "Max-Age=14401"),
        lines[0].replace("Max-Age=14400", "Max-Age=-1"),
        lines[0].replace("Max-Age=14400", "Max-Age=1.5"),
        lines[0].replace("; Secure", ""), lines[0].replace("; HttpOnly", ""),
        format!("{}; Domain=evil.invalid", lines[0]),
        format!("{}; Domain=app.skylit.ai.evil.invalid", lines[0]),
        format!("{}; Path=/api/data", lines[0]),
        lines[0].replace("=synthetic-", "=bad,synthetic-"),
        lines[0].replace("=synthetic-", "=bad\tsynthetic-"),
    ] {
        let mut h = HeaderMap::new();
        h.append(header::SET_COOKIE, HeaderValue::from_str(&bad).unwrap());
        for line in &lines[1..] { h.append(header::SET_COOKIE, HeaderValue::from_str(line).unwrap()); }
        assert!(parse_lease(&h, 14400).is_err());
    }
    for domain in ["app.skylit.ai", ".skylit.ai"] {
        let mut h = HeaderMap::new();
        for line in &lines { h.append(header::SET_COOKIE, HeaderValue::from_str(&format!("{line}; Domain={domain}")).unwrap()); }
        assert!(parse_lease(&h, 14400).is_ok());
    }
    let mut h = HeaderMap::new();
    for (i, line) in lines.iter().enumerate() {
        h.append(header::SET_COOKIE, HeaderValue::from_str(&if i == 0 { line.replace("14400", "60") } else { line.clone() }).unwrap());
    }
    let lease = match parse_lease(&h, 120) { Ok(l) => l, Err(_) => panic!("synthetic lease rejected") };
    assert!(lease.cookie().unwrap().is_sensitive());
    assert_eq!(lease.ttl_seconds(), 60);
    assert!(parse_lease(&valid, 1).is_ok());
    assert!(edge::CookieLease::parse(&valid, "user".into(), 1, Instant::now() - Duration::from_secs(2)).is_err());
}

#[tokio::test]
async fn edge_grant_keeps_cookie_server_side_and_data_is_bound_to_exact_paths_and_owner() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    write_profile(&file, &synthetic_profile(now));
    let f = fixture_with_config(edge_config(&file)).await;
    grant_reply(&f, grant_headers(), serde_json::json!({"ttlSeconds":14400,"expiresAt":"synthetic-expiry","ignored":"synthetic-secret"}));
    let response = f.app.clone().oneshot(capability_request("/api/edge/cookies?attacker=ignored", "{\"untrusted\":true}")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let text = body(response).await;
    assert!(!text.contains("CloudFront")); assert!(!text.contains("synthetic-secret"));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(value["ttlSeconds"].as_u64().is_some_and(|n| n > 0 && n <= 14400));
    assert_eq!(value["expiresAt"], "synthetic-expiry");
    {
        let requests = f.mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].uri, "/api/access");
        assert_eq!(requests[1].uri, "/api/edge/cookies");
        assert_eq!(requests[1].body, b"{}");
        for r in requests.iter() {
            assert!(!r.headers.contains_key(header::COOKIE));
            assert_eq!(r.headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
        }
        assert_eq!(requests[1].headers[header::ORIGIN], f.gateway.upstream.origin().ascii_serialization());
    }
    for method in [Method::GET, Method::HEAD] {
        for path in ["/api/data", "/api/data/range?symbol=SYNTHETIC"] {
            let mut request = authorized_request(method.clone(), path);
            request.headers_mut().insert(header::COOKIE, HeaderValue::from_static("CloudFront-Policy=visitor-must-not-leave"));
            assert_eq!(f.app.clone().oneshot(request).await.unwrap().status(), StatusCode::OK);
        }
    }
    {
        let requests = f.mock.requests.lock().unwrap();
        // Four data requests with one unchanged token: the identity is verified
        // upstream once and then reused, instead of a round trip per request.
        assert_eq!(requests[2..].iter().filter(|r| r.uri == "/api/access").count(), 1);
        assert!(requests[2..].iter().filter(|r| r.uri == "/api/access").all(|r| !r.headers.contains_key(header::COOKIE)));
        for r in requests[2..].iter().filter(|r| r.uri != "/api/access") {
            assert!(r.headers[header::COOKIE].to_str().unwrap().contains("CloudFront-Policy=synthetic-CloudFront-Policy"));
            assert!(!r.headers[header::COOKIE].to_str().unwrap().contains("visitor"));
            assert_eq!(r.headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
        }
    }
    let prior = f.mock.requests.lock().unwrap().len();
    for path in ["/other", "/api/data/", "/api/data/range/", "/api/data/extra", "/api/%64ata", "/api/symbols"] {
        assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap().status(), StatusCode::OK);
    }
    assert!(f.mock.requests.lock().unwrap()[prior..].iter().all(|r| !r.headers.contains_key(header::COOKIE)));
    let mut other = synthetic_profile(now); other["user"]["id"] = serde_json::json!("other_owner");
    write_profile(&file, &other);
    let prior = f.mock.requests.lock().unwrap().len();
    assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, "/api/data")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.mock.requests.lock().unwrap().len(), prior);
    write_profile(&file, &synthetic_profile(now - 121));
    assert_eq!(f.app.clone().oneshot(authorized_request(Method::HEAD, "/api/data")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    // Even a still-fresh old profile cannot authorize a snapshot from another account.
    // An account switch always rotates the token, so the cached check is a miss and
    // the new token is verified upstream before any data is sent.
    write_profile(&file, &synthetic_profile(now));
    std::fs::write(&file.path, snapshot("other.synthetic.token", now, now + 180)).unwrap();
    *f.mock.access.lock().unwrap() = Some((StatusCode::OK, vec![br#"{"user_id":"different_snapshot_owner","application":true}"#.to_vec()]));
    let prior = f.mock.requests.lock().unwrap().len();
    assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, "/api/data")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    let requests = f.mock.requests.lock().unwrap();
    assert_eq!(requests.len(), prior + 1);
    assert_eq!(requests.last().unwrap().uri, "/api/access");
    assert!(!requests.last().unwrap().headers.contains_key(header::COOKIE));
}

#[tokio::test]
async fn edge_missing_expired_lease_and_invalid_grants_fail_closed() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    write_profile(&file, &synthetic_profile(now));
    let f = fixture_with_config(edge_config(&file)).await;
    for method in [Method::GET, Method::HEAD] {
        assert_eq!(f.app.clone().oneshot(authorized_request(method, "/api/data")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
    let mut lease = match parse_lease(&grant_headers(), 14400) { Ok(l) => l, Err(_) => panic!("synthetic lease rejected") };
    lease.expires = Instant::now() - Duration::from_secs(1);
    *f.gateway.edge_lease.lock().unwrap() = Some(lease);
    assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, "/api/data/range")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(f.mock.requests.lock().unwrap().is_empty());
    for value in [serde_json::json!({}), serde_json::json!({"ttlSeconds":0}), serde_json::json!({"ttlSeconds":14401}), serde_json::json!({"ttlSeconds":1.5})] {
        grant_reply(&f, grant_headers(), value);
        let response = f.app.clone().oneshot(capability_request("/api/edge/cookies", "{}")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert_eq!(body(response).await, "Upstream capability unavailable");
    }
    grant_reply(&f, HeaderMap::new(), serde_json::json!({"ttlSeconds":14400}));
    assert_eq!(f.app.clone().oneshot(capability_request("/api/edge/cookies", "{}")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn capability_posts_require_opt_in_local_auth_csrf_and_bounded_body() {
    let f = fixture().await;
    for path in ["/api/edge/cookies", "/api/sse/ticket"] {
        assert_eq!(f.app.clone().oneshot(capability_request(path, "{}")).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(edge_config(&file)).await;
    for path in ["/api/edge/cookies", "/api/sse/ticket"] {
        for origin in [None, Some("null"), Some("https://evil.invalid")] {
            let mut r = capability_request(path, "{}"); r.headers_mut().remove(header::ORIGIN);
            if let Some(o) = origin { r.headers_mut().insert(header::ORIGIN, HeaderValue::from_static(o)); }
            assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::FORBIDDEN);
        }
        let mut r = capability_request(path, "{}"); r.headers_mut().remove(header::AUTHORIZATION);
        assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let mut r = capability_request(path, "{}"); r.headers_mut().append(header::ORIGIN, HeaderValue::from_static(ORIGIN));
        assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(f.app.clone().oneshot(capability_request(path, "x".repeat(MAX_LOGIN_BODY + 1))).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
    for path in ["/api/edge/cookies/", "/api/sse/ticket/", "/write"] {
        assert_eq!(f.app.clone().oneshot(capability_request(path, "{}")).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    // Page-view telemetry is answered locally (never forwarded) on company devices.
    assert_eq!(f.app.clone().oneshot(capability_request("/agent-gateway/platform/api/v1/usage/view", "{}")).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn observed_homepage_read_routes_get_only_trusted_bearer_without_widening_mutations() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(edge_config(&file)).await;
    for &path in FRONTEND_READ_PATHS {
        // "/" is a redirect to the app's default view; every other observed read is a page.
        let path = if path == "/" { HOME_ROUTE } else { path };
        let response = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let request = f.mock.requests.lock().unwrap().last().unwrap().clone();
        assert_eq!(request.headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
        assert!(!request.headers.contains_key(header::COOKIE));
        assert_eq!(f.app.clone().oneshot(authorized_request(Method::POST, path)).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    // Writes on any app path remain forbidden and are never forwarded.
    let previous = f.mock.requests.lock().unwrap().len();
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        let r = f.app.clone().oneshot(authorized_request(method, "/api/nexus/v1/trades")).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }
    assert_eq!(f.mock.requests.lock().unwrap().len(), previous);
    // Account surfaces are blocked before any token could be attached.
    assert_eq!(f.app.clone().oneshot(authorized_request(Method::GET, "/api/nexus/users/me")).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(f.mock.requests.lock().unwrap().len(), previous);
}

#[tokio::test]
async fn sse_ticket_accepts_the_real_empty_post_without_content_type() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(edge_config(&file)).await;
    f.mock.replies.lock().unwrap().insert("/api/sse/ticket".into(), (StatusCode::OK, HeaderMap::new(), vec![br#"{"ticket":"synthetic-empty-post-ticket"}"#.to_vec()]));
    let mut request = capability_request("/api/sse/ticket", "");
    request.headers_mut().remove(header::CONTENT_TYPE);
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let captured = f.mock.requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].uri, "/api/sse/ticket");
    assert_eq!(captured[0].body, b"{}");
    assert!(!captured[0].headers.contains_key(header::COOKIE));
}

#[tokio::test]
async fn sse_ticket_uses_fixed_bearer_target_preserves_json_status_and_filters_headers() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(edge_config(&file)).await;
    for status in [StatusCode::OK, StatusCode::UNAUTHORIZED, StatusCode::TOO_MANY_REQUESTS] {
        let mut headers = grant_headers();
        headers.insert(header::LOCATION, HeaderValue::from_static("https://evil.invalid"));
        headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
        f.mock.replies.lock().unwrap().insert("/api/sse/ticket".into(), (status, headers, vec![br#"{"ticket":"synthetic-ticket"}"#.to_vec()]));
        let response = f.app.clone().oneshot(capability_request("/api/sse/ticket?secret=must-not-forward", "{\"scope\":\"synthetic\"}")).await.unwrap();
        assert_eq!(response.status(), status);
        for h in ["set-cookie", "location", "access-control-allow-origin"] { assert!(!response.headers().contains_key(h)); }
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&body(response).await).unwrap()["ticket"], "synthetic-ticket");
    }
    {
        let requests = f.mock.requests.lock().unwrap(); assert_eq!(requests.len(), 3);
        for r in requests.iter() {
            assert_eq!(r.method, Method::POST); assert_eq!(r.uri, "/api/sse/ticket");
            assert_eq!(r.headers[header::AUTHORIZATION], format!("Bearer {UPSTREAM_TEST_TOKEN}"));
            assert!(!r.headers.contains_key(header::COOKIE)); assert_eq!(r.body, br#"{"scope":"synthetic"}"#);
        }
    }
    let mut r = capability_request("/api/sse/ticket", "{}"); r.headers_mut().remove(header::CONTENT_TYPE);
    assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(f.app.clone().oneshot(capability_request("/api/sse/ticket", "bad-json")).await.unwrap().status(), StatusCode::BAD_REQUEST);
    f.mock.replies.lock().unwrap().insert("/api/sse/ticket".into(), (StatusCode::OK, HeaderMap::new(), vec![vec![b' '; MAX_ACCESS_BODY / 2], vec![b' '; MAX_ACCESS_BODY / 2 + 1]]));
    assert_eq!(f.app.clone().oneshot(capability_request("/api/sse/ticket", "{}")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.mock.requests.lock().unwrap().len(), 4); // No retry.
}

// ---------------------------------------------------------------------------
// Open device access, per-device local state, and account blocking.
// ---------------------------------------------------------------------------
const OPEN_HOST: &str = "gateway.example.test";

fn open_config() -> Config {
    let mut config = config();
    config.enable_open_device_access = true;
    config
}
/// A browser request to the open gateway. `cookie` selects the device.
fn device_request(method: Method, uri: &str, cookie: Option<&str>, body: Option<&str>) -> Request {
    let mut r = Request::builder().method(method.clone()).uri(uri).header(header::HOST, OPEN_HOST);
    if let Some(cookie) = cookie { r = r.header(header::COOKIE, cookie); }
    if method != Method::GET && method != Method::HEAD { r = r.header(header::ORIGIN, ORIGIN); }
    if body.is_some() { r = r.header(header::CONTENT_TYPE, "application/json"); }
    r.body(body.map(|b| Body::from(b.to_owned())).unwrap_or_else(Body::empty)).unwrap()
}
/// First visit with no cookie: open mode must issue a device cookie and admit.
async fn new_device(f: &Fixture) -> String {
    let response = f.app.clone().oneshot(device_request(Method::GET, "/tv/presets", None, None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let set = response.headers()[header::SET_COOKIE].to_str().unwrap().to_owned();
    assert!(set.contains("HttpOnly") && set.contains("SameSite=Strict"));
    set.split(';').next().unwrap().to_owned()
}
async fn json_of(response: Response) -> serde_json::Value {
    serde_json::from_str(&body(response).await).unwrap()
}

#[tokio::test]
async fn open_mode_needs_no_access_code_and_issues_a_stable_device_identity() {
    let f = fixture_with_config(open_config()).await;
    let cookie = new_device(&f).await;
    // Reusing the cookie keeps the same device: no second cookie is issued.
    let response = f.app.clone().oneshot(device_request(Method::GET, "/tv/presets", Some(&cookie), None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
    // The access-code page is gone; it sends the browser to the site instead.
    let response = f.app.clone().oneshot(device_request(Method::GET, "/_gateway/login", None, None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(response.headers()[header::LOCATION], "/");
    // The default (non-open) mode still requires the access code.
    let closed = fixture().await;
    let response = closed.app.clone().oneshot(Request::builder().uri("/tv/presets").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn open_mode_rejects_a_foreign_host_and_cross_site_writes() {
    let f = fixture_with_config(open_config()).await;
    // DNS rebinding: a hostile name resolving to the gateway must not be served.
    for host in ["evil.invalid", "gateway.example.test.evil.invalid", "127.0.0.1"] {
        let r = Request::builder().uri("/").header(header::HOST, host).body(Body::empty()).unwrap();
        assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::MISDIRECTED_REQUEST);
    }
    let r = Request::builder().uri("/").body(Body::empty()).unwrap();
    assert_eq!(f.app.clone().oneshot(r).await.unwrap().status(), StatusCode::MISDIRECTED_REQUEST);
    let cookie = new_device(&f).await;
    for origin in [None, Some("https://evil.invalid"), Some("null")] {
        let mut r = Request::builder().method(Method::PUT).uri("/tv/presets").header(header::HOST, OPEN_HOST)
            .header(header::COOKIE, &cookie).header(header::CONTENT_TYPE, "application/json");
        if let Some(o) = origin { r = r.header(header::ORIGIN, o); }
        let response = f.app.clone().oneshot(r.body(Body::from("{\"presets\":[]}")).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn device_state_is_isolated_between_devices_and_never_sent_upstream() {
    let f = fixture_with_config(open_config()).await;
    let a = new_device(&f).await;
    let b = new_device(&f).await;
    assert_ne!(a, b);
    let put = |c: &str, uri: &str, body: &str| device_request(Method::PUT, uri, Some(c), Some(body));
    assert_eq!(f.app.clone().oneshot(put(&a, "/tv/layouts/main", r#"{"name":"A layout","values":{"panes":2}}"#)).await.unwrap().status(), StatusCode::OK);
    assert_eq!(f.app.clone().oneshot(put(&a, "/tv/drawings/SPY", r#"{"drawings":[{"id":"d1","tool":"trend"}]}"#)).await.unwrap().status(), StatusCode::OK);
    assert_eq!(f.app.clone().oneshot(device_request(Method::POST, "/api/favorites/SPY", Some(&a), None)).await.unwrap().status(), StatusCode::OK);
    assert_eq!(f.app.clone().oneshot(device_request(Method::POST, "/api/watchlists", Some(&a), Some(r#"{"name":"Mine","symbols":["SPY"]}"#))).await.unwrap().status(), StatusCode::OK);

    let get = |c: &str, uri: &str| device_request(Method::GET, uri, Some(c), None);
    let layouts_a = json_of(f.app.clone().oneshot(get(&a, "/tv/layouts")).await.unwrap()).await;
    assert_eq!(layouts_a["layouts"].as_array().unwrap().len(), 1);
    assert_eq!(layouts_a["layouts"][0]["name"], "A layout");
    let layouts_b = json_of(f.app.clone().oneshot(get(&b, "/tv/layouts")).await.unwrap()).await;
    assert_eq!(layouts_b, serde_json::json!({"layouts": [], "updatedAt": 0}));
    assert_eq!(json_of(f.app.clone().oneshot(get(&a, "/tv/drawings/SPY")).await.unwrap()).await["drawings"][0]["id"], "d1");
    assert_eq!(json_of(f.app.clone().oneshot(get(&b, "/tv/drawings/SPY")).await.unwrap()).await["drawings"], serde_json::json!([]));
    assert_eq!(json_of(f.app.clone().oneshot(get(&a, "/api/favorites")).await.unwrap()).await["favorites"], serde_json::json!(["SPY"]));
    assert_eq!(json_of(f.app.clone().oneshot(get(&b, "/api/favorites")).await.unwrap()).await["favorites"], serde_json::json!([]));
    assert_eq!(json_of(f.app.clone().oneshot(get(&a, "/api/watchlists")).await.unwrap()).await["watchlists"].as_array().unwrap().len(), 1);
    assert_eq!(json_of(f.app.clone().oneshot(get(&b, "/api/watchlists")).await.unwrap()).await["watchlists"], serde_json::json!([]));
    // None of this per-device state may ever reach the upstream account.
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn device_state_replies_match_the_original_frontend_contracts() {
    let f = fixture_with_config(open_config()).await;
    let c = new_device(&f).await;
    let send = |m: Method, uri: &str, body: Option<&str>| device_request(m, uri, Some(&c), body);

    // Layouts: ETag + 304, version increments, 409 on a stale baseVersion, DELETE.
    let item = json_of(f.app.clone().oneshot(send(Method::PUT, "/tv/layouts/w1", Some(r#"{"name":"W","values":{"x":1}}"#))).await.unwrap()).await;
    assert_eq!(item["id"], "w1"); assert_eq!(item["version"], 1); assert!(item["updatedAt"].is_number());
    let list = f.app.clone().oneshot(send(Method::GET, "/tv/layouts", None)).await.unwrap();
    let etag = list.headers()[header::ETAG].to_str().unwrap().to_owned();
    let mut cached = send(Method::GET, "/tv/layouts", None);
    cached.headers_mut().insert(header::IF_NONE_MATCH, HeaderValue::from_str(&etag).unwrap());
    assert_eq!(f.app.clone().oneshot(cached).await.unwrap().status(), StatusCode::NOT_MODIFIED);
    let item = json_of(f.app.clone().oneshot(send(Method::PUT, "/tv/layouts/w1", Some(r#"{"name":"W2","values":{},"baseVersion":1}"#))).await.unwrap()).await;
    assert_eq!(item["version"], 2);
    let conflict = f.app.clone().oneshot(send(Method::PUT, "/tv/layouts/w1", Some(r#"{"name":"W3","values":{},"baseVersion":1}"#))).await.unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(json_of(conflict).await["currentVersion"], 2);
    let forced = json_of(f.app.clone().oneshot(send(Method::PUT, "/tv/layouts/w1", Some(r#"{"name":"W4","values":{},"baseVersion":1,"force":true}"#))).await.unwrap()).await;
    assert_eq!(forced["version"], 3);
    assert_eq!(f.app.clone().oneshot(send(Method::DELETE, "/tv/layouts/w1", None)).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(f.app.clone().oneshot(send(Method::DELETE, "/tv/layouts/absent", None)).await.unwrap().status(), StatusCode::NO_CONTENT);

    // Drawings: the client rejects replies unless each item has string id and tool.
    let bad = f.app.clone().oneshot(send(Method::PUT, "/tv/drawings/SPY", Some(r#"{"drawings":[{"id":"x"}]}"#))).await.unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let echoed = json_of(f.app.clone().oneshot(send(Method::PUT, "/tv/drawings/SPY", Some(r#"{"drawings":[{"id":"d","tool":"hline","p":1}]}"#))).await.unwrap()).await;
    assert_eq!(echoed["symbol"], "SPY"); assert!(echoed["updatedAt"].is_number()); assert_eq!(echoed["drawings"][0]["tool"], "hline");
    let bulk = json_of(f.app.clone().oneshot(send(Method::GET, "/tv/drawings", None)).await.unwrap()).await;
    assert_eq!(bulk["drawings"]["SPY"][0]["id"], "d");
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::GET, "/tv/drawings/QQQ", None)).await.unwrap()).await["updatedAt"], serde_json::Value::Null);

    // Presets and watchlist-order defaults, then round-trip.
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::GET, "/tv/presets", None)).await.unwrap()).await,
        serde_json::json!({"presets": [], "activeByTool": {}, "updatedAt": 0}));
    let p = json_of(f.app.clone().oneshot(send(Method::PUT, "/tv/presets", Some(r#"{"presets":[{"id":"p"}],"activeByTool":{"hline":"p"}}"#))).await.unwrap()).await;
    assert_eq!(p["activeByTool"]["hline"], "p");
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::GET, "/tv/watchlist-order", None)).await.unwrap()).await["sectionOrder"], serde_json::json!([]));
    let o = json_of(f.app.clone().oneshot(send(Method::PUT, "/tv/watchlist-order", Some(r#"{"sectionOrder":["a"],"symbolOrder":{}}"#))).await.unwrap()).await;
    assert_eq!(o["sectionOrder"], serde_json::json!(["a"]));

    // Watchlists: create returns {watchlist}, update merges, delete succeeds.
    let created = json_of(f.app.clone().oneshot(send(Method::POST, "/api/watchlists", Some(r#"{"name":"L"}"#))).await.unwrap()).await;
    let id = created["watchlist"]["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("wl_")); assert_eq!(created["watchlist"]["symbols"], serde_json::json!([]));
    let updated = json_of(f.app.clone().oneshot(send(Method::PUT, &format!("/api/watchlists/{id}"), Some(r#"{"name":"L2","id":"hijack"}"#))).await.unwrap()).await;
    assert_eq!(updated["watchlist"]["name"], "L2"); assert_eq!(updated["watchlist"]["id"], id.as_str());
    assert_eq!(f.app.clone().oneshot(send(Method::PUT, "/api/watchlists/missing", Some("{}"))).await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(f.app.clone().oneshot(send(Method::DELETE, &format!("/api/watchlists/{id}"), None)).await.unwrap().status(), StatusCode::OK);

    // Favorites: the real client posts with no body and no Content-Type.
    let added = json_of(f.app.clone().oneshot(send(Method::POST, "/api/favorites/ES1", None)).await.unwrap()).await;
    assert_eq!(added["favorites"], serde_json::json!(["ES1"]));
    let again = json_of(f.app.clone().oneshot(send(Method::POST, "/api/favorites/ES1", None)).await.unwrap()).await;
    assert_eq!(again["favorites"], serde_json::json!(["ES1"]));
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::DELETE, "/api/favorites/ES1", None)).await.unwrap()).await["favorites"], serde_json::json!([]));
    assert_eq!(f.app.clone().oneshot(send(Method::POST, "/api/favorites/bad%20sym", None)).await.unwrap().status(), StatusCode::BAD_REQUEST);

    // Preferences.
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::GET, "/siren/preferences", None)).await.unwrap()).await, serde_json::json!({}));
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::PUT, "/siren/preferences", Some(r#"{"sound":true}"#))).await.unwrap()).await["sound"], true);
    let talon = "/agent-gateway/platform/api/v1/talon/preferences";
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::GET, talon, None)).await.unwrap()).await, serde_json::json!({"prefs_json": {}}));
    assert_eq!(json_of(f.app.clone().oneshot(send(Method::PUT, talon, Some(r#"{"prefs_json":{"k":1}}"#))).await.unwrap()).await["prefs_json"]["k"], 1);

    assert_eq!(f.app.clone().oneshot(send(Method::PUT, "/tv/presets", Some("not json"))).await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn account_and_settings_surfaces_are_blocked_without_reaching_upstream() {
    let f = fixture_with_config(open_config()).await;
    let c = new_device(&f).await;
    for path in ["/user-profile", "/user-profile?tab=billing", "/developer", "/developer/keys", "/affiliate/welcome",
        "/invite", "/sign-in", "/user", "/api/developer/keys", "/api/njord/me/billing/overview",
        "/api/njord/me/payment-settings", "/api/njord/me/invite/leaderboard", "/api/nexus/users/me"] {
        for method in [Method::GET, Method::POST] {
            let response = f.app.clone().oneshot(device_request(method, path, Some(&c), None)).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path} must be blocked");
        }
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
    // Exact-segment matching: lookalike paths are not swallowed by the block list.
    for path in ["/usernames", "/developers-blog", "/invited", "/flows", "/fs/api/alerts", "/fs/api/opra-agreement",
        "/nexusx", "/api/nexus/legal/terms-status", "/api/nexus/support/tickets"] {
        assert!(!device_state::account_blocked(path), "{path} must not be blocked");
    }
    // Flowseeker and Nexus pages are blocked on request.
    for path in ["/flow", "/flow/live", "/flow/scanner", "/flow/tracker", "/nexus", "/nexus/leaderboard", "/nexus/settings"] {
        assert!(device_state::account_blocked(path), "{path} must be blocked");
    }
}

#[test]
fn device_state_persists_per_device_and_rejects_unsafe_ids() {
    let mut id = [0u8; 8];
    OsRng.fill_bytes(&mut id);
    let root = std::env::temp_dir();
    let dir = root.join(format!("skylit-device-state-test-{}", hex::encode(id)));
    assert_eq!(dir.parent(), Some(root.as_path()));
    std::fs::create_dir(&dir).unwrap();
    let device = "a".repeat(64);
    {
        let store = device_state::Store::new(Some(dir.clone()));
        let response = store.handle(&device, &Method::POST, "/api/favorites/SPY", None, b"");
        assert_eq!(response.status(), StatusCode::OK);
    }
    // A fresh store (e.g. after a container restart) reads the device back from disk.
    let store = device_state::Store::new(Some(dir.clone()));
    let response = store.handle(&device, &Method::GET, "/api/favorites", None, b"");
    assert_eq!(response.status(), StatusCode::OK);
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(format!("{device}.json"))).unwrap()).unwrap();
    assert_eq!(saved["favorites"], serde_json::json!(["SPY"]));
    // A different device has its own (empty) state on the same disk.
    let other = "b".repeat(64);
    assert_eq!(store.handle(&other, &Method::GET, "/api/favorites", None, b"").status(), StatusCode::OK);
    assert!(!dir.join(format!("{other}.json")).exists());
    for bad in ["", "A".repeat(64).as_str(), "../etc", &"a".repeat(63), &format!("{}/x", "a".repeat(62))] {
        assert!(!device_state::valid_device_id(bad));
    }
    // Cleanup: only our exact temp directory and its known files.
    assert!(dir.file_name().unwrap().to_str().unwrap().starts_with("skylit-device-state-test-"));
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        assert_eq!(path.parent(), Some(dir.as_path()));
        std::fs::remove_file(path).unwrap();
    }
    std::fs::remove_dir(&dir).unwrap();
}

#[tokio::test]
async fn portless_origin_from_an_extension_is_accepted_only_with_same_origin_fetch_metadata() {
    let mut cfg = open_config();
    cfg.public_origin = "http://gateway.example.test:48175".into();
    let f = fixture_with_config(cfg).await;
    let host = "gateway.example.test:48175";
    let first = f.app.clone().oneshot(Request::builder().uri("/tv/presets").header(header::HOST, host)
        .body(Body::empty()).unwrap()).await.unwrap();
    let cookie = first.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let put = |origin: &str, fetch_site: Option<&str>| {
        let mut r = Request::builder().method(Method::PUT).uri("/tv/presets").header(header::HOST, host)
            .header(header::COOKIE, &cookie).header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(s) = fetch_site { r = r.header("sec-fetch-site", s); }
        r.body(Body::from("{\"presets\":[]}")).unwrap()
    };
    // Exact origin keeps working as before.
    assert_eq!(f.app.clone().oneshot(put("http://gateway.example.test:48175", None)).await.unwrap().status(), StatusCode::OK);
    // The extension-stripped portless origin passes only with browser-proven same-origin.
    assert_eq!(f.app.clone().oneshot(put("http://gateway.example.test", Some("same-origin"))).await.unwrap().status(), StatusCode::OK);
    for (origin, site) in [("http://gateway.example.test", None), ("http://gateway.example.test", Some("same-site")),
        ("http://gateway.example.test", Some("cross-site")), ("https://gateway.example.test", Some("same-origin")),
        ("http://evil.invalid", Some("same-origin")), ("http://gateway.example.test:9999", Some("same-origin"))] {
        assert_eq!(f.app.clone().oneshot(put(origin, site)).await.unwrap().status(), StatusCode::FORBIDDEN, "{origin} {site:?}");
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn every_app_page_gets_the_adapter_not_only_home_and_atlas() {
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let f = fixture_with_config(edge_config(&file)).await;
    // Build the page from whatever chunks the manifest currently pins, so this test does
    // not hardcode a build.
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("frontend/manifest.json").expect("manifest")).expect("json");
    let page = format!("<!doctype html><html><head>{}</head><body>app</body></html>",
        manifest["assets"].as_array().expect("assets").iter()
            .map(|asset| format!("<script src=\"{}\" async></script>", asset["path"].as_str().expect("path")))
            .collect::<String>());
    let mut html = HeaderMap::new();
    html.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    for (path, status) in [("/tempest", StatusCode::OK), ("/academy", StatusCode::OK), ("/talon", StatusCode::NOT_FOUND)] {
        f.mock.replies.lock().unwrap().insert(path.into(), (status, html.clone(), vec![page.as_bytes().to_vec()]));
        let response = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        // The original status is kept (a real upstream 404 stays 404, not a gateway 502).
        assert_eq!(response.status(), status, "{path}");
        let text = body(response).await;
        assert!(text.contains("data-skylit-gateway-auth-runtime"), "{path} must load the adapter");
        assert!(text.contains("data-skylit-gateway-account-hidden"), "{path} must hide the account area");
    }
    // A document that does not load the pinned chunks passes through unchanged.
    let plain = "<!doctype html><html><head></head><body>plain</body></html>";
    f.mock.replies.lock().unwrap().insert("/plain".into(), (StatusCode::OK, html.clone(), vec![plain.as_bytes().to_vec()]));
    let response = f.app.clone().oneshot(authorized_request(Method::GET, "/plain")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, plain);
}

#[tokio::test]
async fn page_view_telemetry_is_answered_locally_on_company_devices() {
    let f = fixture_with_config(open_config()).await;
    let c = new_device(&f).await;
    let r = f.app.clone().oneshot(device_request(Method::POST, "/agent-gateway/platform/api/v1/usage/view",
        Some(&c), Some(r#"{"route":"/atlas"}"#))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn content_hashed_static_assets_are_browser_cacheable_but_api_and_pages_are_not() {
    let f = fixture().await;
    let r = f.app.clone().oneshot(authorized_request(Method::GET, "/_next/static/chunks/abc123.js")).await.unwrap();
    assert_eq!(r.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    for path in ["/", "/atlas", "/api/symbols", "/_next/static/../api/x", "/_next/data/x.json"] {
        let r = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store", "{path}");
    }
}

/// A snapshot directory with one document and one asset. The shell loads whatever chunks
/// the committed manifest currently pins, so this test never hardcodes a build.
fn write_mirror(dir: &std::path::Path) -> std::path::PathBuf {
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("frontend/manifest.json").expect("manifest")).expect("manifest json");
    let tags: String = manifest["assets"].as_array().expect("assets").iter()
        .map(|asset| format!("<script src=\"{}\" async></script>", asset["path"].as_str().expect("path")))
        .collect();
    let shell = format!("<!doctype html><html><head>{tags}</head><body>snapshot-marker</body></html>");
    std::fs::create_dir_all(dir.join("__shell")).unwrap();
    std::fs::create_dir_all(dir.join("_next/static/chunks")).unwrap();
    std::fs::write(dir.join("__shell/index.html"), &shell).unwrap();
    std::fs::write(dir.join("_next/static/chunks/other-abc.js"), "console.log('snapshot asset');").unwrap();
    std::fs::write(dir.join("index.json"), serde_json::json!({
        "schemaVersion": 1, "capturedAt": "2026-10-24T00:00:00.000Z", "origin": "https://app.skylit.ai",
        "routes": [{ "route": "/", "file": "__shell/index.html" }],
        "entries": [
            { "path": "/", "contentType": "text/html; charset=utf-8", "bytes": shell.len(), "kind": "document" },
            { "path": "/_next/static/chunks/other-abc.js", "contentType": "application/javascript; charset=utf-8",
              "bytes": 30, "kind": "script" },
        ],
    }).to_string()).unwrap();
    dir.to_path_buf()
}

#[tokio::test]
async fn snapshot_serves_the_shell_and_assets_without_asking_upstream() {
    let dir = std::env::temp_dir().join(format!("skylit-mirror-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = write_mirror(&dir);
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let mut config = edge_config(&file);
    config.frontend_mirror_dir = root.clone();
    let f = fixture_with_config(config).await;

    // "/" always lands on the app's default view, keeping any query string.
    let redirect = f.app.clone().oneshot(authorized_request(Method::GET, "/?symbol=SPXW")).await.unwrap();
    assert_eq!(redirect.status(), StatusCode::FOUND);
    assert_eq!(redirect.headers()[header::LOCATION], format!("{HOME_ROUTE}?symbol=SPXW"));
    assert_eq!(f.mock.requests.lock().unwrap().len(), 0, "a redirect must not reach upstream");

    // The shell comes from the snapshot, still rewritten for the adapter.
    let page = f.app.clone().oneshot(authorized_request(Method::GET, HOME_ROUTE)).await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()["x-skylit-frontend-source"], "snapshot");
    let text = body(page).await;
    assert!(text.contains("data-skylit-gateway-auth-runtime"));
    assert!(text.contains("snapshot-marker"), "content must come from the snapshot file");

    // Static assets come from the snapshot too, and stay browser-cacheable.
    let asset = f.app.clone().oneshot(authorized_request(Method::GET, "/_next/static/chunks/other-abc.js")).await.unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(asset.headers()["x-skylit-frontend-source"], "snapshot");
    assert_eq!(asset.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    assert!(body(asset).await.contains("snapshot asset"));

    // Nothing above reached upstream.
    assert!(f.mock.requests.lock().unwrap().is_empty());

    // A path outside the snapshot still proxies live (data and unknown chunks).
    let live = f.app.clone().oneshot(authorized_request(Method::GET, "/api/symbols")).await.unwrap();
    assert_eq!(live.status(), StatusCode::OK);
    assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn snapshot_never_answers_data_paths_even_if_an_entry_matches() {
    let dir = std::env::temp_dir().join(format!("skylit-mirror-data-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = write_mirror(&dir);
    // A hostile/corrupt index must not let the snapshot shadow a data API.
    std::fs::write(root.join("index.json"), serde_json::json!({
        "schemaVersion": 1, "routes": [],
        "entries": [{ "path": "/api/symbols", "contentType": "application/json; charset=utf-8", "bytes": 2 }],
    }).to_string()).unwrap();
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let mut config = edge_config(&file);
    config.frontend_mirror_dir = root.clone();
    let f = fixture_with_config(config).await;
    let r = f.app.clone().oneshot(authorized_request(Method::GET, "/api/symbols")).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    // Served by the mock upstream, not from the snapshot.
    assert!(r.headers().get("x-skylit-frontend-source").is_none());
    assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn snapshot_serves_pinned_chunks_patched_and_refuses_a_foreign_build() {
    let dir = std::env::temp_dir().join(format!("skylit-mirror-pinned-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = write_mirror(&dir);
    // Copy the real pinned sources into the snapshot under their request paths.
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("frontend/manifest.json").expect("manifest")).expect("json");
    for asset in manifest["assets"].as_array().expect("assets") {
        let path = asset["path"].as_str().expect("path").trim_start_matches('/');
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().expect("parent")).unwrap();
        if std::fs::copy(format!("../.local/live-chunks/{}", asset["filename"].as_str().expect("name")), &file).is_err() {
            std::fs::write(&file, b"not the pinned build").unwrap();
        }
    }
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let mut config = edge_config(&file);
    config.frontend_mirror_dir = root.clone();
    let f = fixture_with_config(config).await;

    let pinned = manifest["assets"][0]["path"].as_str().expect("path");
    let r = f.app.clone().oneshot(authorized_request(Method::GET, pinned)).await.unwrap();
    if root.join(pinned.trim_start_matches('/')).exists()
        && std::fs::read(root.join(pinned.trim_start_matches('/'))).map(|b| crate::frontend::sha256_hex(&b))
            .ok().as_deref() == manifest["assets"][0]["originalSha256"].as_str() {
        // The snapshot holds the pinned build: the patched bytes are served, no upstream hit.
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["x-skylit-frontend-source"], "snapshot");
        assert!(body(r).await.contains("__SKYLIT_GATEWAY_AUTH"));
        assert!(f.mock.requests.lock().unwrap().is_empty());
    } else {
        // A snapshot with a different build must refuse rather than serve code the patches
        // were not generated for (that is what broke the page originally).
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn document_static_urls_carry_the_build_tag_so_a_cdn_cannot_serve_a_stale_copy() {
    use crate::frontend::{rewrite_document, snapshot_tag};
    // Every pinned chunk must appear, or the rewrite correctly refuses the document.
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("frontend/manifest.json").expect("manifest")).expect("json");
    let pinned: String = manifest["assets"].as_array().expect("assets").iter()
        .map(|asset| format!("<script src=\"{}\" async></script>", asset["path"].as_str().expect("path")))
        .collect();
    let html = rewrite_document(&format!("<html><head>{pinned}\
<script src=\"/_next/static/chunks/a.js\" async></script>\
<link href=\"/_next/static/css/b.css\" rel=\"stylesheet\">\
<script src=\"/_next/static/chunks/other.js?v=1\"></script>\
</head><body>plain</body></html>")).unwrap_or_else(|_| panic!("rewrite failed"));
    let tag = snapshot_tag();
    assert!(html.contains(&format!("/_next/static/chunks/a.js?_snap={tag}")), "unpinned asset tagged");
    assert!(html.contains(&format!("/_next/static/css/b.css?_snap={tag}")));
    // An existing query is left alone: changing it could break the site's own versioning.
    assert!(html.contains("/_next/static/chunks/other.js?v=1"));
    assert!(!html.contains("?_snap={tag}?_snap"), "must not double-tag");
    // Non-static URLs are untouched.
    assert!(!html.contains("/api/symbols?_snap"));
}

#[test]
fn brand_renames_display_text_but_never_breaks_identifiers_or_links() {
    use crate::brand::Brand;
    let brand = Brand::from_env();
    // Display text is renamed, in both cases the app uses.
    for text in ["Skylit Team", "SKYLIT · Oct 24, 2026", "Skylit Terminal", "Skylit plan"] {
        let out = brand.rewrite(text).unwrap_or_default();
        assert!(out.contains(brand.name()), "{text} -> {out}");
        assert!(!out.contains("Skylit") && !out.contains("SKYLIT"), "{text} -> {out}");
    }
    // Identifiers, links and the upstream repo keep their bytes: renaming those would
    // break the adapter hook, inbound links, or the app's own wiring.
    for keep in ["window.__SKYLIT_GATEWAY_AUTH.bindReact(x)", "https://app.skylit.ai/docs",
        "https://github.com/SkylitAI/skylit-frontend/pull/5901", "SkylitAI/skylit-arc-research",
        "onShowSkylitAI", "skylit_share_mode"] {
        assert_eq!(brand.rewrite(keep).as_deref(), None, "must stay untouched: {keep}");
    }
    // The vendor mark is redirected to the new one.
    assert_eq!(brand.rewrite("/brand/skylit-satin-graphite-dark-256.png").as_deref(),
        Some("/_gateway/brand/satin-graphite-dark-256.png"));
}

#[test]
fn brand_document_swaps_icon_links_and_manifest_carries_the_new_name() {
    use crate::brand::Brand;
    let brand = Brand::from_env();
    let html = r#"<head><link rel="icon" href="/favicon-32x32.png?v=1"/><link rel="manifest" href="/manifest.webmanifest"/><link rel="icon" href="/icon-192x192.png?v=2"/></head>"#;
    let out = brand.rewrite_document(html);
    assert_eq!(out.matches("href=\"/_gateway/brand/mark.svg\"").count(), 2, "{out}");
    // The manifest link is not an icon and must survive.
    assert!(out.contains("href=\"/manifest.webmanifest\""));
    let manifest = brand.manifest();
    assert!(manifest.contains(brand.name()));
    assert!(!manifest.contains("Skylit"));
    assert!(manifest.contains("/_gateway/brand/mark.svg"));
}

#[tokio::test]
async fn unknown_pages_do_not_silently_render_the_home_view() {
    let dir = std::env::temp_dir().join(format!("skylit-mirror-404-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = write_mirror(&dir);
    let now = epoch_now();
    let file = SessionFile::new(Some(&snapshot(UPSTREAM_TEST_TOKEN, now, now + 180)));
    let mut config = edge_config(&file);
    config.frontend_mirror_dir = root.clone();
    let f = fixture_with_config(config).await;

    // "/" is the home view: it redirects so the client router cannot restore the last page.
    let redirect = f.app.clone().oneshot(authorized_request(Method::GET, "/")).await.unwrap();
    assert_eq!(redirect.status(), StatusCode::FOUND);
    assert_eq!(redirect.headers()[header::LOCATION], HOME_ROUTE);

    // The home alias still gets the shell (and therefore the app).
    let alias = f.app.clone().oneshot(authorized_request(Method::GET, HOME_ROUTE)).await.unwrap();
    assert_eq!(alias.status(), StatusCode::OK);
    assert_eq!(alias.headers()["x-skylit-frontend-source"], "snapshot");

    // "/dashboard" is a label in the sidebar, not a route: it opens the same home view.
    let dashboard = f.app.clone().oneshot(authorized_request(Method::GET, "/dashboard")).await.unwrap();
    assert_eq!(dashboard.status(), StatusCode::FOUND);
    assert_eq!(dashboard.headers()[header::LOCATION], HOME_ROUTE);

    // A page the snapshot does not have is a 404, not a page that looks like home.
    for path in ["/academy/5baa8dcf-52a2-4506-a0fa-db0eb594d5b6", "/nowhere"] {
        let response = f.app.clone().oneshot(authorized_request(Method::GET, path)).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        let body = body(response).await;
        assert!(body.contains("这个页面不在当前缓存的前端版本里"), "{path}");
        assert!(!body.contains("data-skylit-gateway-auth-runtime"), "must not boot the app: {path}");
    }
    // Data paths are untouched by this rule.
    assert!(f.app.clone().oneshot(authorized_request(Method::GET, "/api/symbols")).await.unwrap().status().is_success());
    assert!(f.mock.requests.lock().unwrap().iter().any(|r| r.uri == "/api/symbols"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn public_origin_is_a_single_origin_not_a_destination_url() {    assert_eq!(parse_origin("https://gateway.example.test/").unwrap(), ORIGIN);
    for bad in ["null", "file:///tmp", "https://user:password@gateway.example.test", "https://gateway.example.test/path", "https://gateway.example.test/?query", "https://gateway.example.test/#fragment"] {
        assert!(parse_origin(bad).is_err());
    }
}
