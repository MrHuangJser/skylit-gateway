// Parse public archives only. Never import, eval or execute vendor JavaScript.
import { parse } from 'acorn';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TARGETS = Object.freeze({
  // Current build. Chunk names and module ids are re-discovered with
  // validation/map-live-seam-ast.mjs after every upstream deploy. Both layers below
  // re-export the Clerk surface, so both are replaced: depending on the import site the
  // app may resolve the auth hooks through either one.
  '3ehfb7p2agn0l.js': {
    965389: ['useAuth', 'useSignIn', 'useSignUp'],
    265829: ['SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading'],
    733917: ['UserButton'],
    192448: ['ClerkProvider', 'SignInButton', 'SignOutButton'],
    827085: ['useClerk', 'useUser', 'useSession', 'useOrganization', 'useOrganizationList'],
  },
  '44ald-muhquop.js': {
    496136: ['useAuth', 'useClerk', 'useUser', 'useSession', 'useSignIn', 'useSignUp', 'useOrganization', 'useOrganizationList'],
    927534: ['SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading'],
    // The root provider the app actually renders; without this the Clerk instance is
    // still created and the SDK is loaded from the vendor CDN.
    441895: ['ClientClerkProvider'],
  },
});

// Public export name -> adapter API name, for bindings the adapter exposes differently.
const API_NAME = Object.freeze({ ClientClerkProvider: 'ClerkProvider' });

// Exact source edits for code the export table cannot reach. The Clerk isomorphic client
// loads the vendor SDK from clerk.skylit.ai the moment an instance is created, which the
// vendor rejects for this domain and which crashes the tree. Disabling that single call
// keeps the instance inert; every auth hook the app uses comes from the adapter anyway.
const SOURCE_PATCHES = Object.freeze({
  '3ehfb7p2agn0l.js': [
    { find: '&&this.loadClerkJS()', replace: '&&void 0' },
  ],
});
export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
export function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, fn);
    else if (value && typeof value === 'object') walk(value, fn);
  }
}
export function parseJS(source) { return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
export function exportsIn(source) {
  const exports = [];
  walk(parseJS(source), node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed ||
      node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'e' || node.callee.property.name !== 's' ||
      node.arguments[0]?.type !== 'ArrayExpression') return;
    const moduleId = node.arguments[1]?.value ?? null;
    const values = node.arguments[0].elements;
    for (let index = 0; index < values.length;) {
      const name = values[index++];
      if (name?.type !== 'Literal' || typeof name.value !== 'string') throw new Error('Unknown export-name encoding');
      const direct = values[index]?.type === 'Literal' && values[index].value === 0;
      if (direct) index++;
      const binding = values[index++];
      if (!binding) throw new Error('Missing export binding');
      if (!direct && !['ArrowFunctionExpression', 'FunctionExpression'].includes(binding.type)) throw new Error('Unknown getter encoding');
      exports.push({ moduleId, name: name.value, kind: direct ? 'direct' : 'getter', start: binding.start, end: binding.end });
    }
  });
  return exports;
}
export function patchAsset(source, filename) {
  const expected = TARGETS[filename];
  if (!expected) throw new Error('Unsupported asset');
  const entries = exportsIn(source), edits = [];
  for (const [moduleId, names] of Object.entries(expected)) for (const name of names) {
    const matches = entries.filter(entry => entry.moduleId === Number(moduleId) && entry.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${filename}:${moduleId}:${name}; got ${matches.length}`);
    const match = matches[0];
    const binding = `window.__SKYLIT_GATEWAY_AUTH.bindReact(e.i(271645)).${API_NAME[name] ?? name}`;
    edits.push({ ...match, original: source.slice(match.start, match.end), replacement: match.kind === 'getter' ? `()=>${binding}` : binding });
  }
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) throw new Error('Overlapping export patches');
  let output = source;
  for (const edit of [...edits].reverse()) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  parseJS(output);
  const patchedExports = exportsIn(output);
  if (patchedExports.length !== entries.length) throw new Error('Export count changed');
  entries.forEach((entry, index) => {
    const next = patchedExports[index];
    if (entry.moduleId !== next.moduleId || entry.name !== next.name || entry.kind !== next.kind) throw new Error('Export layout changed');
    const edit = edits.find(edit => edit.start === entry.start);
    if (output.slice(next.start, next.end) !== (edit ? edit.replacement : source.slice(entry.start, entry.end))) throw new Error('Unexpected export modification');
  });
  // Source-level edits for code outside the export table.
  for (const patch of SOURCE_PATCHES[filename] ?? []) {
    const occurrences = output.split(patch.find).length - 1;
    if (occurrences !== 1) throw new Error(`Expected exactly one "${patch.find}" in ${filename}; got ${occurrences}`);
    output = output.replace(patch.find, patch.replace);
  }
  parseJS(output);
  return { output, edits };
}
export async function generate() {
  const frontend = new URL('../frontend/', import.meta.url);
  await mkdir(new URL('patches/', frontend), { recursive: true });
  const assets = [];
  for (const filename of Object.keys(TARGETS)) {
    // Original third-party chunks are not committed; point SKYLIT_ASSET_ARCHIVE at a local copy.
    const archive = process.env.SKYLIT_ASSET_ARCHIVE
      ? new URL(`file:///${process.env.SKYLIT_ASSET_ARCHIVE.replace(/\\/g, '/').replace(/^\/+/, '')}/`)
      : new URL('../../api-recon/assets/', import.meta.url);
    const input = await readFile(new URL(filename, archive));
    const source = input.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(input)) throw new Error('Public asset must be UTF-8');
    const { output, edits } = patchAsset(source, filename);
    await writeFile(new URL(`patches/${filename}`, frontend), output);
    assets.push({ path: `/_next/static/chunks/${filename}`, filename, originalSha256: sha256(input), patchedSha256: sha256(output),
      originalSRI: `sha384-${createHash('sha384').update(input).digest('base64')}`, patchedSRI: `sha384-${createHash('sha384').update(output).digest('base64')}`,
      bindings: edits.map(({ moduleId, name, kind }) => ({ moduleId, name, kind })) });
  }
  const manifest = { schemaVersion: 1, adapter: 'gateway-auth-adapter.js', fullWebsiteReady: false,
    method: 'AST export binding replacement only; vendor code never executed', assets };
  await writeFile(new URL('manifest.json', frontend), JSON.stringify(manifest, null, 2) + '\n');
  const rust = '// Generated from archived public assets by validation/generate-auth-patches.mjs.\n' +
    'pub const PATCHES: &[(&str, &str, &[u8])] = &[\n' + assets.map(asset =>
      `    (${JSON.stringify(asset.path)}, ${JSON.stringify(asset.originalSha256)}, include_bytes!("patches/${asset.filename}")),`).join('\n') + '\n];\n' +
    'pub const CRITICAL_BASENAMES: &[&str] = &[\n' + assets.map(asset => `    ${JSON.stringify(asset.filename)},`).join('\n') + '\n];\n';
  await writeFile(new URL('generated.rs', frontend), rust);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await generate();
  console.log(JSON.stringify({ generated: manifest.assets.map(asset => ({ path: asset.path, originalSha256: asset.originalSha256, patches: asset.bindings.length })), fullWebsiteReady: false }, null, 2));
}
