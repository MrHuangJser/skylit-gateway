// Capture a complete, self-consistent frontend snapshot into frontend/mirror so the
// gateway can serve the app from a fixed build instead of following upstream deploys.
//
// What is captured: the HTML shell for the routes we serve, every static chunk they
// reference (recursively, since chunks import chunks), and CSS/media (fonts live in CSS).
// What is NOT captured: API routes and RSC navigation payloads, which stay live.
//
// Refuses to write when the build no longer matches the pinned patch manifest: regenerate
// the patches for the new build first (see validation/map-live-seam-ast.mjs).
import { mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ORIGIN = process.env.SNAPSHOT_ORIGIN || 'https://app.skylit.ai';
const FINAL = join(fileURLToPath(new URL('../frontend/mirror/', import.meta.url)), '..', 'mirror');
const ROOT = `${FINAL}.staging`;
// Every page the owner navigates to. Routes that upstream answers with a non-200 are
// skipped with a warning (some pages only render for a signed-in browser).
const ROUTES = (process.env.SNAPSHOT_ROUTES || [
  '/', '/atlas', '/alerts', '/dashboard', '/calendar', '/stages', '/portal', '/products',
  '/support', '/talon', '/tempest', '/trinity', '/academy', '/heatseeker/alerts', '/book',
  '/heatseeker/heatmaps', '/live-stages',
].join(',')).split(',').map(r => r.trim()).filter(Boolean);
const MAX_TOTAL = Number(process.env.SNAPSHOT_MAX_BYTES || 64 * 1024 * 1024);
// Routes with a dynamic segment. The document for one id is captured and served for every
// id: the code is identical, and the page loads its own data by id after hydration.
// Each entry is "pattern@sampleId"; the id may be omitted and SNAPSHOT_TEMPLATE_ID used.
const TEMPLATES = (process.env.SNAPSHOT_TEMPLATES || [
  '/stages/__ID__@477ecfb2-e85a-4486-8e04-e54019b5c37e',
  '/stages/__ID__/replay@477ecfb2-e85a-4486-8e04-e54019b5c37e',
  '/academy/__ID__@5b8aa8cf-52a2-4506-af0a-db0eb594d5b6',
].join(',')).split(',').map(t => t.trim()).filter(Boolean)
  .map(entry => {
    const [pattern, id] = entry.split('@');
    return { pattern: pattern.trim(), id: (id || process.env.SNAPSHOT_TEMPLATE_ID || '').trim() };
  });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
const manifest = JSON.parse(await readFile(new URL('../frontend/manifest.json', import.meta.url), 'utf8'));
const pinnedByPath = new Map(manifest.assets.map(a => [a.path, a]));

const seen = new Map();          // path -> { sha256, bytes, contentType, kind }
let total = 0;
const queue = [];
const enqueue = path => { if (path && !seen.has(path) && !queue.includes(path)) queue.push(path); };

const contentTypeFor = path => {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
};

// Paths that are never mirrored (dynamic or per-request).
const isDynamic = path => /^\/(api|tv|siren|agent-gateway|flow|nexus)\//.test(path) || path.startsWith('/_next/data/');

function collectRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(/["'(]((?:\/_next\/static|)\/[A-Za-z0-9_@.\-]+\/[A-Za-z0-9_@.\-/]+\.(?:js|css|woff2?|png|jpe?g|svg|webp))/g)) {
    const path = m[1].startsWith('/_next/') ? m[1] : m[1];
    if (path.startsWith('/_next/static/') || path.startsWith('/static/')) refs.add(path);
  }
  // Dynamic import chunk ids appear as bare chunk names in some builds.
  for (const m of text.matchAll(/["'](\/_next\/static\/chunks\/[A-Za-z0-9_\-.]+\.js)["']/g)) refs.add(m[1]);
  return refs;
}

const fileFor = path => join(ROOT, path.replace(/^\//, ''));

// Route -> stored file. Documents live under __shell/ so they never collide with the
// mirrored asset tree (route "/" must not become the mirror directory itself).
const shellFileFor = route => join(ROOT, '__shell', route === '/' ? 'index.html'
  : `${route.replace(/^\//, '').replace(/\//g, '__')}/index.html`);

// Protected routes answer 404 for an anonymous client. A short-lived bearer (read from the
// gateway's own snapshot) only selects the document; no account data is rendered into it.
const BEARER = (process.env.SNAPSHOT_BEARER || '').trim();

async function fetchOne(path) {
  const headers = { 'User-Agent': UA };
  if (BEARER) headers.Authorization = `Bearer ${BEARER}`;
  if (!/\.(js|css|woff2?|png|jpe?g|svg)$/.test(path)) headers.Accept = 'text/html';
  const res = await fetch(`${ORIGIN}${path}`, { headers, signal: AbortSignal.timeout(30000) });
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, upstreamType: res.headers.get('content-type') || '' };
}

// 1. Capture the HTML shells first; they define the chunk set for their build.
const shellFiles = new Map();
for (const route of ROUTES) {
  // A route this deployment does not have is skipped, not fatal: the gateway serves the
  // captured root shell for unmatched deep links, so a missing route is not a failure.
  let fetched;
  try { fetched = await fetchOne(route); }
  catch (error) { console.warn(`skip route ${route}: ${String(error.message).slice(0, 60)}`); continue; }
  const { buf } = fetched;
  const html = buf.toString('utf8');
  shellFiles.set(route, shellFileFor(route));
  for (const ref of collectRefs(html)) enqueue(ref);
  total += buf.length;
  seen.set(route, {
    sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length,
    contentType: 'text/html; charset=utf-8', kind: 'document',
  });
  await mkdir(dirname(shellFileFor(route)), { recursive: true });
  await writeFile(shellFileFor(route), buf);
}

// 1b. Capture one instance of each dynamic route as a template.
const templates = [];
for (const { pattern, id: sampleId } of TEMPLATES) {
  if (!sampleId) { console.warn(`skip template ${pattern}: no sample id`); continue; }
  const real = pattern.replace('__ID__', sampleId);
  let fetched;
  try { fetched = await fetchOne(real); }
  catch (error) { console.warn(`skip template ${pattern}: ${String(error.message).slice(0, 60)}`); continue; }
  const { buf } = fetched;
  const file = join(ROOT, '__tpl', `${pattern.replace(/[^a-z0-9]+/gi, '_')}.html`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  for (const ref of collectRefs(buf.toString('utf8'))) enqueue(ref);
  total += buf.length;
  templates.push({ pattern, source: real, capturedId: sampleId, file: file.slice(ROOT.length).split(String.fromCharCode(92)).join('/'),
    sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
  console.log(`template ${pattern} <- ${real} (${buf.length} bytes)`);
}

// 2. Walk JS/CSS so nested imports and fonts are included too.
while (queue.length) {
  const path = queue.shift();
  if (seen.has(path) || isDynamic(path)) continue;
  let fetched;
  try { fetched = await fetchOne(path); }
  catch (error) { console.warn(`skip ${path}: ${String(error.message).slice(0, 80)}`); continue; }
  const { buf } = fetched;
  total += buf.length;
  if (total > MAX_TOTAL) throw new Error(`mirror exceeds ${MAX_TOTAL} bytes`);
  if (/\.(js|css)$/.test(path)) for (const ref of collectRefs(buf.toString('utf8'))) enqueue(ref);
  seen.set(path, {
    sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length,
    contentType: contentTypeFor(path), kind: path.endsWith('.js') ? 'script' : path.endsWith('.css') ? 'style' : 'asset',
  });
  await mkdir(dirname(fileFor(path)), { recursive: true });
  await writeFile(fileFor(path), buf);
}

// 3. Every pinned chunk must be present, otherwise the mirror cannot be served safely.
for (const [pinnedPath, asset] of pinnedByPath) {
  const entry = seen.get(pinnedPath);
  assert.ok(entry, `mirror is missing the pinned chunk ${pinnedPath}; upstream has moved on, regenerate the patches first`);
  assert.equal(entry.sha256, asset.originalSha256,
    `mirror captured a different build for ${pinnedPath}; regenerate the patches first`);
}

const index = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  origin: ORIGIN,
  routes: [...shellFiles.entries()].map(([route, file]) => ({
    route, file: file.slice(ROOT.length).split('\\').join('/'),
  })),
  templates,
  totalBytes: total,
  entries: [...seen.entries()]
    .map(([path, meta]) => ({ path, ...meta }))
    .sort((a, b) => a.path.localeCompare(b.path)),
};
await writeFile(join(ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n');

// Swap the completed capture into place only now: a partial capture is worthless and
// must never replace a working snapshot.
await rm(FINAL, { recursive: true, force: true }).catch(() => {});
await rename(ROOT, FINAL);
const byKind = Object.groupBy(index.entries, e => e.kind);
console.log(JSON.stringify({
  capturedAt: index.capturedAt,
  documents: byKind.document?.length ?? 0,
  scripts: byKind.script?.length ?? 0,
  styles: byKind.style?.length ?? 0,
  assets: byKind.asset?.length ?? 0,
  templates,
  totalBytes: total,
}, null, 2));
