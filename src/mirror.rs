//! Local frontend snapshot.
//!
//! The upstream rebuilds its frontend without warning; every rebuild renames the static
//! chunks the auth adapter hooks into, which used to take the whole app down until the
//! patches were regenerated. Serving a captured snapshot removes upstream from the
//! critical path: the shell and its chunks stay byte-identical to the build the patches
//! were generated against, and only data APIs keep talking to upstream.
//!
//! The snapshot is produced by `validation/snapshot-frontend.mjs` and committed under
//! `frontend/mirror/`. Nothing here interprets the files; it only answers lookups.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default)]
    routes: Vec<Route>,
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    captured_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Route {
    route: String,
    file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    #[allow(dead_code)] // recorded for humans inspecting index.json
    bytes: u64,
}

/// One resolvable snapshot resource.
pub(crate) struct Mirrored {
    pub file: PathBuf,
    pub content_type: &'static str,
    pub document: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Mirror {
    root: PathBuf,
    /// Request path -> (stored file, content type, is a document).
    files: HashMap<String, (String, String, bool)>,
    captured_at: Option<String>,
    entries: usize,
}

impl Mirror {
    /// Loads the snapshot index. A missing or malformed index disables the mirror; the
    /// gateway then behaves exactly as before (live upstream), so this is never fatal.
    pub(crate) fn load(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        let index_path = root.join("index.json");
        let Ok(raw) = std::fs::read(&index_path) else { return Self { root, ..Default::default() } };
        let Ok(index) = serde_json::from_slice::<Index>(&raw) else {
            eprintln!("frontend mirror: {} is not a valid index; serving live upstream", index_path.display());
            return Self { root, ..Default::default() };
        };
        let mut files = HashMap::new();
        for entry in index.entries {
            let stored = entry.path.trim_start_matches('/').to_owned();
            files.insert(entry.path, (
                stored,
                entry.content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
                false,
            ));
        }
        // Documents are inserted last: the generator also lists each route in `entries`
        // (as a captured file), and the route must resolve as a document, not an asset.
        for route in index.routes {
            // Documents are stored under __shell/; the served path is the route itself.
            files.insert(route.route, (route.file, "text/html; charset=utf-8".to_owned(), true));
        }
        Self { root, entries: files.len(), files, captured_at: index.captured_at }
    }

    pub(crate) fn is_empty(&self) -> bool { self.files.is_empty() }
    pub(crate) fn len(&self) -> usize { self.entries }
    pub(crate) fn captured_at(&self) -> Option<&str> { self.captured_at.as_deref() }

    /// The captured root document, used when a deep link has no snapshot of its own: the
    /// client router takes over from the shell.
    pub(crate) fn shell(&self) -> Option<Mirrored> { self.resolve("/") }

    /// Resolves a request path. Only static assets and captured documents qualify, so a
    /// stray API or data path can never be answered from the snapshot.
    pub(crate) fn resolve(&self, path: &str) -> Option<Mirrored> {        if path.contains("..") { return None; }
        let (relative, content_type, document) = self.files.get(path)?;
        // Documents are exact route matches; assets must live under a static prefix.
        let static_asset = path.starts_with("/_next/static/") || path.starts_with("/static/");
        if !*document && !static_asset { return None; }
        Some(Mirrored {
            file: self.root.join(relative),
            content_type: known_content_type(content_type),
            document: *document,
        })
    }
}

/// The content types come from a small fixed set in the snapshot index; mapping them to
/// statics keeps `resolve` allocation-free without inventing strings per request.
fn known_content_type(value: &str) -> &'static str {
    static KNOWN: &[&str] = &[
        "text/html; charset=utf-8", "application/javascript; charset=utf-8",
        "text/css; charset=utf-8", "font/woff2", "font/woff", "image/svg+xml",
        "image/png", "image/jpeg", "image/webp", "application/json; charset=utf-8",
        "application/octet-stream",
    ];
    KNOWN.iter().copied().find(|known| *known == value).unwrap_or("application/octet-stream")
}
