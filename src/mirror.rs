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
    templates: Vec<Template>,
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

/// A dynamic route captured once: `pattern` holds `__ID__` where the id goes, and the same
/// document is served for every id (the code is identical; the page loads its own data).
#[derive(Debug, Deserialize)]
struct Template {
    pattern: String,
    file: String,
    /// The id the document was captured for; the served copy has it swapped out.
    #[serde(default, rename = "capturedId")]
    captured_id: Option<String>,
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
    /// For a dynamic route: the id the document was captured for, and the id requested.
    /// The captured document embeds its own id, so the served copy is rewritten.
    pub substitute: Option<(String, String)>,
}

#[derive(Debug, Default)]
pub(crate) struct Mirror {
    root: PathBuf,
    /// Request path -> (stored file, content type, is a document).
    files: HashMap<String, (String, String, bool)>,
    /// (prefix, suffix, stored file, captured id) for dynamic routes.
    templates: Vec<(String, String, String, String)>,
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
            let stored = normalize_relative(&entry.path);
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
            // The stored file is relative to the snapshot root, with or without a leading
            // separator depending on how it was recorded.
            files.insert(route.route, (normalize_relative(&route.file), "text/html; charset=utf-8".to_owned(), true));
        }
        let mut templates = Vec::new();
        for template in index.templates {
            // "/stages/__ID__/replay" -> prefix "/stages/", suffix "/replay"
            let Some((prefix, rest)) = template.pattern.split_once("__ID__") else { continue };
            let captured = template.captured_id.clone().unwrap_or_default();
            templates.push((prefix.to_owned(), rest.to_owned(), normalize_relative(&template.file), captured));
        }
        // Longest prefix first so "/stages/x/replay" wins over a broader pattern.
        templates.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        Self { root, entries: files.len(), files, templates, captured_at: index.captured_at }
    }

    pub(crate) fn is_empty(&self) -> bool { self.files.is_empty() }
    pub(crate) fn len(&self) -> usize { self.entries }
    pub(crate) fn captured_at(&self) -> Option<&str> { self.captured_at.as_deref() }

    /// The captured root document, used when a deep link has no snapshot of its own: the
    /// client router takes over from the shell.
    pub(crate) fn shell(&self) -> Option<Mirrored> { self.resolve("/") }

    /// Resolves a request path. Only static assets and captured documents qualify, so a
    /// stray API or data path can never be answered from the snapshot.
    pub(crate) fn resolve(&self, path: &str) -> Option<Mirrored> {
        if path.contains("..") { return None; }
        // Documents are exact route matches; assets must live under a static prefix. This
        // is what keeps a corrupt index from letting the snapshot answer a data API.
        let static_asset = path.starts_with("/_next/static/") || path.starts_with("/static/");
        if let Some((relative, content_type, document)) = self.files.get(path) {
            if !*document && !static_asset { return None; }
            return Some(Mirrored {
                file: self.root.join(relative),
                content_type: known_content_type(content_type),
                document: *document,
                substitute: None,
            });
        }
        // Dynamic routes: one captured document answers every id.
        for (prefix, suffix, file, captured) in &self.templates {
            let matched = path.strip_prefix(prefix.as_str())
                .and_then(|rest| rest.strip_suffix(suffix.as_str()));
            if let Some(id) = matched {
                if !id.is_empty() && !id.contains('/') {
                    let substitute = (!captured.is_empty() && captured != id)
                        .then(|| (captured.clone(), id.to_owned()));
                    return Some(Mirrored {
                        file: self.root.join(file),
                        content_type: "text/html; charset=utf-8",
                        document: true,
                        substitute,
                    });
                }
            }
        }
        None
    }
}

/// Strips leading separators so `root.join(relative)` always stays inside the snapshot.
fn normalize_relative(value: &str) -> String {
    value.trim_start_matches(['/', '\\']).to_owned()
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
