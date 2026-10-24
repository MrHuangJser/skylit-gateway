//! White-label layer applied to the cached frontend at serve time.
//!
//! The snapshot files stay byte-identical to the build the auth patches were generated
//! against, so their hashes keep verifying; the rename and the skin are applied to the
//! bytes on the way out and cached in memory.
//!
//! Only display text is renamed. Domains (`skylit.ai`), storage keys, custom event names
//! and header names stay as they are: rewriting those would break links, persistence and
//! the gateway's own cookie.

/// Where the renamed brand mark is served from.
pub(crate) const BRAND_LOGO_PATH: &str = "/_gateway/brand/mark.svg";

pub(crate) struct Brand {
    enabled: bool,
    name: String,
    /// The upstream mark this replaces; any `/brand/skylit-*` path is redirected.
    accent: String,
    accent_soft: String,
}

impl Brand {
    pub(crate) fn from_env() -> Self {
        let enabled = std::env::var("BRAND_ENABLED").map(|v| v.trim() != "false").unwrap_or(true);
        let name = std::env::var("BRAND_NAME").ok().map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty()).unwrap_or_else(|| "娃哈哈".to_owned());
        let accent = std::env::var("BRAND_ACCENT").ok().map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty()).unwrap_or_else(|| "#e2231a".to_owned());
        Self { enabled, name, accent, accent_soft: "#f7c948".to_owned() }
    }

    pub(crate) fn enabled(&self) -> bool { self.enabled }
    pub(crate) fn name(&self) -> &str { &self.name }

    /// Renames display text and points the brand mark at our own asset.
    /// Returns `None` when nothing changed, so callers can skip caching a copy.
    pub(crate) fn rewrite(&self, input: &str) -> Option<String> {
        if !self.enabled { return None; }
        let mut changed = false;
        let mut out = String::with_capacity(input.len() + 64);
        let bytes = input.as_bytes();
        let mut cursor = 0;
        while let Some(found) = find_brand(input, cursor) {
            // Context guards: keep URLs, repo slugs, asset paths and internal identifiers
            // (the adapter hook is `window.__SKYLIT_GATEWAY_AUTH`) intact.
            let before = out.as_bytes().last().copied();
            let after = &input[found + "Skylit".len()..];
            let keep = matches!(before, Some(b'/') | Some(b':') | Some(b'.') | Some(b'-') | Some(b'_'))
                || after.starts_with("AI")
                || after.starts_with("_GATEWAY")
                || after.starts_with("_gateway")
                || after.starts_with(".ai")
                || after.starts_with(".dev")
                || after.starts_with(".com");
            out.push_str(&input[cursor..found]);
            if keep { out.push_str(&input[found..found + "Skylit".len()]); }
            else { out.push_str(&self.name); changed = true; }
            cursor = found + "Skylit".len();
            let _ = bytes;
        }
        out.push_str(&input[cursor..]);
        if out.contains("/brand/skylit-") {
            out = out.replace("/brand/skylit-", "/_gateway/brand/");
            changed = true;
        }
        if changed { Some(out) } else { None }
    }

    /// The install/PWA manifest, renamed and pointing at the new mark.
    pub(crate) fn manifest(&self) -> String {
        format!(
r##"{{"name":"{name} - Options Flow Analytics","short_name":"{name}","description":"Real-time options gamma and vanna exposure heatmaps with smart alerts","start_url":"/","display":"standalone","background_color":"#0b0b0c","theme_color":"{accent}","orientation":"any","scope":"/","icons":[{{"src":"{logo}","sizes":"any","type":"image/svg+xml","purpose":"any"}}]}}"##,
            name = self.name, accent = self.accent, logo = BRAND_LOGO_PATH)
    }

    /// Document-level branding: rename text, then swap the old icon links for the new mark.
    pub(crate) fn rewrite_document(&self, html: &str) -> String {
        let renamed = self.rewrite(html).unwrap_or_else(|| html.to_owned());
        if !self.enabled { return renamed; }
        replace_icon_hrefs(&renamed)
    }

    /// Skin: a warm 娃哈哈 palette over the existing dark surfaces.
    pub(crate) fn stylesheet(&self) -> String {
        format!(
r#"<style data-skylit-brand="1">
:root{{
  --skylit-accent:{accent};
  --skylit-accent-soft:{soft};
  --popover-active-ring:{accent};
  --popover-active-bg:color-mix(in srgb, {accent} 16%, transparent);
  --popover-active-text:#fff5f0;
}}
body{{background-image:radial-gradient(1200px 500px at 15% -10%, color-mix(in srgb, {accent} 12%, transparent), transparent 70%);}}
/* Wordmark: the upstream mark is replaced by the new one; keep the original footprint. */
img[src^="/_gateway/brand/"]{{border-radius:6px;object-fit:contain;max-width:1em;max-height:1em;}}
/* Sidebar: warm tint and a brand edge on the active entry. */
aside,aside[data-component="sidebar"],nav[aria-label]{{
  background-image:linear-gradient(180deg, color-mix(in srgb, {accent} 10%, transparent), transparent 320px);
}}
aside a[aria-current="page"],aside a[data-active="true"],nav a[aria-current="page"]{{
  background:color-mix(in srgb, {accent} 18%, transparent)!important;
  box-shadow:inset 2px 0 0 {accent};
  color:#fff3ef!important;
}}
/* Buttons and links that carried the old brand colour. */
button[class*="bg-primary"],a[class*="bg-primary"],[data-variant="brand"]{{
  background:{accent}!important;border-color:{accent}!important;color:#fff!important;
}}
button:hover,a:hover{{border-color:color-mix(in srgb, {accent} 60%, transparent);}}
a:hover{{color:color-mix(in srgb, {accent} 70%, #ffffff);}}
::selection{{background:color-mix(in srgb, {accent} 45%, transparent);}}
/* A brand stripe so the skin reads as a skin, not a stray accent. */
body::before{{content:"";position:fixed;inset:0 0 auto 0;height:3px;z-index:2147483647;pointer-events:none;
  background:linear-gradient(90deg,{accent}, {soft}, {accent});opacity:.95;}}
</style>"#,
            accent = self.accent, soft = self.accent_soft)
    }

    /// The replacement mark: a square badge carrying the new brand character.
    pub(crate) fn logo_svg(&self) -> String {
        let glyph = self.name.chars().next().map(|c| c.to_string()).unwrap_or_else(|| "娃".to_owned());
        format!(
r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="{name}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{accent}"/><stop offset="1" stop-color="#b3160f"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="{soft}" stroke-opacity=".55" stroke-width="4"/>
  <text x="128" y="170" text-anchor="middle" font-size="140" font-weight="700"
        font-family="'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif" fill="#fff6f2">{glyph}</text>
</svg>"##,
            name = self.name, accent = self.accent, soft = self.accent_soft, glyph = glyph)
    }
}

/// Finds the next brand token (`Skylit` or `SKYLIT`) at or after `from`.
fn find_brand(input: &str, from: usize) -> Option<usize> {
    let rest = &input[from..];
    let upper = rest.find("SKYLIT");
    let mixed = rest.find("Skylit");
    match (upper, mixed) {
        (Some(a), Some(b)) => Some(from + a.min(b)),
        (Some(a), None) | (None, Some(a)) => Some(from + a),
        (None, None) => None,
    }
}

/// Points every old brand icon link at the new mark, replacing the whole attribute value
/// (the originals carry cache-busting query strings, so a prefix swap would corrupt them).
fn replace_icon_hrefs(html: &str) -> String {
    const OLD: [&str; 4] = ["/favicon-", "/icon-", "/apple-touch-icon", "/brand/skylit-"];
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("href=\"") {
        let (before, from) = rest.split_at(at);
        out.push_str(before);
        let value_start = "href=\"".len();
        let Some(end) = from[value_start..].find('"').map(|i| value_start + i) else {
            out.push_str(from);
            return out;
        };
        let value = &from[value_start..end];
        if OLD.iter().any(|prefix| value.starts_with(prefix)) {
            out.push_str("href=\"");
            out.push_str(BRAND_LOGO_PATH);
            out.push('"');
        } else {
            out.push_str(&from[..=end]);
        }
        rest = &from[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Whether a snapshot file may contain renameable text.
pub(crate) fn is_text_asset(content_type: &str, path: &str) -> bool {
    content_type.starts_with("text/") || content_type.contains("javascript") || content_type.contains("json")
        || path.ends_with(".js") || path.ends_with(".css") || path.ends_with(".svg") || path.ends_with(".html")
}

/// Appends the skin to a document, just before `</head>` so it wins over app styles.
pub(crate) fn inject_stylesheet(document: &str, sheet: &str) -> String {
    if sheet.is_empty() || document.contains("data-skylit-brand") { return document.to_owned(); }
    match document.find("</head>") {
        Some(at) => {
            let mut out = String::with_capacity(document.len() + sheet.len());
            out.push_str(&document[..at]);
            out.push_str(sheet);
            out.push_str(&document[at..]);
            out
        }
        // No head (an error page): prepend so the palette still applies.
        None => format!("{sheet}{document}"),
    }
}
