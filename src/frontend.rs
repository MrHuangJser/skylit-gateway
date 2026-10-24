//! Opt-in, version-pinned frontend transport adapter. This does not grant upstream rights.
use axum::{body::Body, http::{header, HeaderMap, HeaderValue, StatusCode}, response::Response};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[path = "../frontend/generated.rs"]
mod generated;

const MAX_REWRITE_BYTES: usize = 4 * 1024 * 1024;
const RUNTIME_PATH: &str = "/_gateway/auth/adapter.js";

pub(crate) enum RewriteError { Version, Encoding, TooLarge, Transport, Html }
impl RewriteError {
    pub(crate) fn response(self) -> Response {
        // Explicit diagnostic, never mistaken for a working original website by the E2E test.
        let message = match self {
            Self::Version => "原站前端版本或完整性校验不匹配，已停止适配。",
            Self::Encoding => "原站资源编码暂不支持，已停止适配。",
            Self::TooLarge => "原站资源超过安全转换大小限制。",
            Self::Transport => "原站页面资源读取失败或超时。",
            Self::Html => "原站页面结构暂不支持当前授权适配。",
        };
        let html = format!("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Gateway frontend diagnostic</title><main data-skylit-gateway-diagnostic=\"error\"><h1>原版页面尚未加载</h1><p>{message}</p><p>这是代理诊断信息，不是原版 Skylit 页面。</p></main></html>");
        let mut response = Response::new(Body::from(html));
        *response.status_mut() = StatusCode::BAD_GATEWAY;
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        super::local(response)
    }
}

pub(crate) fn runtime_script() -> Response {
    let mut response = Response::new(Body::from(include_bytes!("../frontend/gateway-auth-adapter.js").as_slice()));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/javascript; charset=utf-8"));
    super::local(response)
}

/// Rewrites one HTML document (injecting the adapter, hiding the account area, removing
/// the vendor Clerk script). Shared by the live path and the snapshot path so both behave
/// identically.
pub(crate) fn rewrite_document(original: &str) -> Result<String, RewriteError> {
    if generated::CRITICAL_BASENAMES.iter().any(|name| original.contains(name)) {
        Ok(version_static_urls(&rewrite_html(original, generated::CRITICAL_BASENAMES)?))
    } else if original.contains("clerk.skylit.ai") {
        // A build whose chunk names we do not know: the adapter cannot be injected, and
        // serving it would load the vendor SDK and blank the page. Fail loudly instead.
        Err(RewriteError::Version)
    } else {
        Ok(original.to_owned()) // static error/placeholder document
    }
}

/// Identifies the pinned build AND the active brand. Changes whenever the patches are
/// regenerated or the branding changes, so it works as a cache-busting tag: without the
/// brand part, re-skinning would keep serving the previously cached, unbranded chunks.
pub(crate) fn snapshot_tag() -> &'static str {
    static TAG: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TAG.get_or_init(|| {
        let sha = generated::PATCHES.first().map(|patch| patch.1).unwrap_or("00000000");
        let name = std::env::var("BRAND_NAME").ok().map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty()).unwrap_or_else(|| "娃哈哈".to_owned());
        let enabled = std::env::var("BRAND_ENABLED").map(|v| v.trim() != "false").unwrap_or(true);
        if !enabled || name.is_empty() {
            return sha[..8].to_owned();
        }
        // FNV-1a: deterministic across restarts, which a default hasher is not guaranteed
        // to be. Only the tag has to be stable, not cryptographic.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in name.as_bytes() { hash ^= u64::from(*byte); hash = hash.wrapping_mul(0x100_0000_01b3); }
        format!("{}-{:08x}", &sha[..8], (hash ^ (hash >> 32)) as u32)
    })
}

/// Appends the build tag to every static asset URL in the document.
///
/// A CDN can hold a copy of `/_next/static/chunks/x.js` cached as `immutable` from before
/// the gateway started patching that path. That entry cannot be invalidated from here, and
/// because the bytes at that URL changed (raw -> patched) the cached copy is now wrong.
/// Tagging the URL gives the browser and the CDN a cache key that only exists once the
/// patches for that build exist, so a stale copy can never be selected again.
fn version_static_urls(html: &str) -> String {
    let tag = snapshot_tag();
    let mut out = String::with_capacity(html.len() + 256);
    let mut rest = html;
    while let Some(start) = rest.find("/_next/static/") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        // The URL ends at a quote, whitespace, or a delimiter; keep any existing query.
        let end = tail.find(['"', '\'', '`', ' ', ')', '>', '\\', '\n']).unwrap_or(tail.len());
        let (url, after) = tail.split_at(end);
        out.push_str(url);
        if !url.contains('?') { out.push_str("?_snap="); out.push_str(tag); }
        rest = after;
    }
    out.push_str(rest);
    out
}

pub(crate) fn is_pinned_script(path: &str) -> bool {
    generated::PATCHES.iter().any(|patch| patch.0 == path)
}

/// The embedded patched bytes and the upstream hash they were generated from.
pub(crate) fn patch_for(path: &str) -> Option<(&'static str, &'static [u8])> {
    generated::PATCHES.iter().find(|patch| patch.0 == path).map(|patch| (patch.1, patch.2))
}

/// A Service Worker that dismantles the original site's caching worker: it drops every
/// cache and unregisters itself. It must NOT reload the open tabs: the site registers
/// this file on every load, so reloading here would loop forever. Unregistering is
/// enough — the next navigation is then served by the proxy instead of a cache.
/// Served with no-store so the browser re-checks it on each navigation.
const RETIRING_SW: &str = r#"// Managed by the gateway: the upstream caching worker is retired on company devices.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try { for (const key of await caches.keys()) await caches.delete(key); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
  })());
});
// Never serve a cached document: let every request go to the network.
self.addEventListener('fetch', event => { event.respondWith(fetch(event.request)); });
"#;

pub(crate) fn retiring_service_worker() -> Response {
    let mut response = Response::new(Body::from(RETIRING_SW));
    response.headers_mut().insert(header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"));
    response.headers_mut().insert("service-worker-allowed", HeaderValue::from_static("/"));
    let mut response = super::local(response);
    // no-store (set by local) keeps the browser from caching the retiring worker itself.
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store, max-age=0"));
    response
}

fn verify_hash(bytes: &[u8], expected: &str) -> bool {
    hex::encode(Sha256::digest(bytes)) == expected
}

/// SHA-256 of a snapshot file, for checking it against the pinned manifest.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn rewritten_headers(headers: &HeaderMap, content_type: &'static str) -> HeaderMap {
    let mut headers = headers.clone();
    for name in ["etag", "last-modified", "content-md5", "digest", "content-encoding", "content-length", "accept-ranges", "content-range"] {
        headers.remove(name);
    }
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers
}

/// Called only for an authenticated GET and with already-sanitized response headers.
/// Non-target responses are not read and remain available for normal streaming.
pub(crate) async fn rewrite_if_needed(path: &str, upstream: &mut reqwest::Response,
    clean_headers: &HeaderMap) -> Result<Option<Response>, RewriteError> {
    let patch = generated::PATCHES.iter().find(|patch| patch.0 == path);
    // EVERY HTML document needs the adapter: each app page loads the patched auth
    // chunks, which crash ("reading 'bindReact'") if the adapter was not injected.
    // This used to be limited to "/" and "/atlas", which broke all other pages.
    let html = !path.starts_with("/_next/") && clean_headers.get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).is_some_and(|value| value.starts_with("text/html"));
    if patch.is_none() && !html { return Ok(None); }
    let status = upstream.status();
    if patch.is_some() && status != StatusCode::OK { return Err(RewriteError::Version); }
    // Non-200 documents (the original site's own 404/500 pages) are rewritten too,
    // so they render normally, but keep their original status code.
    if html && !(status.is_success() || status.is_client_error() || status.is_server_error()) {
        return Ok(None);
    }
    if clean_headers.get(header::CONTENT_ENCODING).is_some_and(|value| value != "identity") {
        return Err(RewriteError::Encoding);
    }
    if upstream.content_length().is_some_and(|size| size > MAX_REWRITE_BYTES as u64) {
        return Err(RewriteError::TooLarge);
    }
    let bytes = tokio::time::timeout(Duration::from_secs(10), async {
        let mut bytes = Vec::new();
        while let Some(chunk) = upstream.chunk().await.map_err(|_| RewriteError::Transport)? {
            if chunk.len() > MAX_REWRITE_BYTES - bytes.len() { return Err(RewriteError::TooLarge); }
            bytes.extend_from_slice(&chunk);
        }
        Ok::<_, RewriteError>(bytes)
    }).await.map_err(|_| RewriteError::Transport)??;
    let (body, content_type) = if let Some(patch) = patch {
        if !verify_hash(&bytes, patch.1) { return Err(RewriteError::Version); }
        (Body::from(patch.2), "application/javascript; charset=utf-8")
    } else {
        let original = String::from_utf8(bytes).map_err(|_| RewriteError::Encoding)?;
        (Body::from(rewrite_document(&original)?), "text/html; charset=utf-8")
    };
    let mut response = Response::new(body);
    *response.status_mut() = if patch.is_some() { StatusCode::OK } else { status };
    *response.headers_mut() = rewritten_headers(clean_headers, content_type);
    response.headers_mut().insert("x-skylit-gateway-adapter", HeaderValue::from_static("version-pinned"));
    Ok(Some(super::local(response)))
}

fn rewrite_html(original: &str, critical: &[&str]) -> Result<String, RewriteError> {
    if original.contains("data-skylit-gateway-auth-runtime") { return Err(RewriteError::Html); }
    let mut seen = vec![false; critical.len()];
    let mut output = String::with_capacity(original.len() + 160);
    let mut cursor = 0;
    while let Some(relative) = original[cursor..].find("<script") {
        let start = cursor + relative;
        let end_open = start + original[start..].find('>').ok_or(RewriteError::Html)? + 1;
        let end = end_open + original[end_open..].find("</script>").ok_or(RewriteError::Html)? + 9;
        let tag = &original[start..end_open];
        for (i, file) in critical.iter().enumerate() {
            if tag.contains(file) {
                // Do not silently strip SRI or weaken an integrity policy to make a patch load.
                if tag.contains("integrity=") { return Err(RewriteError::Version); }
                seen[i] = true;
            }
        }
        output.push_str(&original[cursor..start]);
        let clerk_sdk = tag.contains("src=\"https://clerk.skylit.ai/")
            || tag.contains("src='https://clerk.skylit.ai/");
        if !clerk_sdk { output.push_str(&original[start..end]); }
        cursor = end;
    }
    output.push_str(&original[cursor..]);
    if seen.iter().any(|seen| !seen) { return Err(RewriteError::Version); }
    let head = output.find("<head>").ok_or(RewriteError::Html)? + "<head>".len();
    let script = format!("<script data-skylit-gateway-auth-runtime=\"version-pinned\" src=\"{RUNTIME_PATH}\"></script>{ACCOUNT_HIDE_STYLE}");
    output.insert_str(head, &script);
    Ok(output)
}

/// Company devices must not see or reach the account/user area. CSS hides the exact
/// sidebar-footer row that contains the account trigger, the trigger itself and the
/// username prompt. The proxy separately blocks the account/settings routes.
const ACCOUNT_HIDE_STYLE: &str = "<style data-skylit-gateway-account-hidden>\
.sidebar-footer-row:has([data-testid=\"account-menu-trigger\"]),\
[data-testid=\"account-menu-trigger\"],\
[data-testid=\"username-prompt\"],\
nav .mt-6:has(> div > [aria-controls=\"sidebar-section-flowseeker\"]),\
nav .mt-6:has(> div > [aria-controls=\"sidebar-section-nexus\"]),\
aside[data-component=\"sidebar\"] a[href^=\"/nexus/\"],\
aside[data-component=\"sidebar\"] a[href=\"/nexus\"],\
aside[data-component=\"sidebar\"] a[href^=\"/flow/\"],\
aside[data-component=\"sidebar\"] a[href=\"/flow\"],\
aside[data-component=\"sidebar\"] a[href=\"/developer\"],\
aside[data-component=\"sidebar\"] a[href^=\"/developer/\"],\
aside[data-component=\"sidebar\"] a[href=\"/affiliate\"],\
aside[data-component=\"sidebar\"] a[href^=\"/affiliate/\"]{display:none!important}</style>";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_injects_runtime_first_and_removes_only_clerk_boot_script() {
        let html = "<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"/a.js\" async></script><script src=\"https://clerk.skylit.ai/npm/clerk.js\" data-clerk-js-script></script><script src=\"/b.js\"></script></head><body><script>self.__next_f.push([1,\"keep\"])</script></body></html>";
        let output = rewrite_html(html, &["a.js", "b.js"]).ok().unwrap();
        assert!(output.starts_with("<!doctype html><html><head><script data-skylit-gateway-auth-runtime="));
        assert!(!output.contains("https://clerk.skylit.ai/"));
        assert!(output.contains("self.__next_f.push([1,\"keep\"])"));
        assert!(output.contains("/a.js\" async"));
    }
    #[test]
    fn html_hides_the_account_area_on_company_devices() {
        let html = "<!doctype html><html><head><script src=\"/a.js\"></script></head><body></body></html>";
        let output = rewrite_html(html, &["a.js"]).ok().unwrap();
        assert!(output.contains("data-skylit-gateway-account-hidden"));
        assert!(output.contains(".sidebar-footer-row:has([data-testid=\"account-menu-trigger\"])"));
        assert!(output.contains("[data-testid=\"username-prompt\"]"));
        assert!(output.contains("display:none!important"));
        // The Flowseeker sidebar section and its links are hidden as well.
        assert!(output.contains("[aria-controls=\"sidebar-section-flowseeker\"]"));
        assert!(output.contains("a[href^=\"/flow/\"]"));
        // The blocked DEVELOPER and PARTNERS (/affiliate) entries are hidden too.
        assert!(output.contains("a[href=\"/developer\"]"));
        assert!(output.contains("a[href=\"/affiliate\"]"));
        // The whole Nexus section is hidden.
        assert!(output.contains("[aria-controls=\"sidebar-section-nexus\"]"));
        assert!(output.contains("a[href^=\"/nexus/\"]"));
    }
    #[test]
    fn unknown_or_integrity_protected_html_fails_closed() {
        assert!(rewrite_html("<html><head></head></html>", &["a.js"]).is_err());
        assert!(rewrite_html("<html><head><script src=\"/a.js\" integrity=\"sha384-test\"></script></head></html>", &["a.js"]).is_err());
        assert!(rewrite_html("<script src=\"/a.js\">", &["a.js"]).is_err());
    }
    #[test]
    fn hash_changes_are_rejected() {
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_hash(b"abc", expected));
        assert!(!verify_hash(b"abd", expected));
    }
    #[test]
    fn rewrite_invalidates_stale_integrity_and_cache_metadata() {
        let mut original = HeaderMap::new();
        original.insert(header::ETAG, HeaderValue::from_static("original"));
        original.insert(header::CONTENT_LENGTH, HeaderValue::from_static("100"));
        original.insert(header::CONTENT_ENCODING, HeaderValue::from_static("identity"));
        original.insert("content-md5", HeaderValue::from_static("not-secret"));
        let headers = rewritten_headers(&original, "application/javascript; charset=utf-8");
        for name in ["etag", "content-length", "content-encoding", "content-md5"] { assert!(!headers.contains_key(name)); }
        assert_eq!(headers[header::CONTENT_TYPE], "application/javascript; charset=utf-8");
    }
}
