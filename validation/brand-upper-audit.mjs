// Upper-case brand text must be gone; lower-case technical identifiers may stay.
import { readFile } from 'node:fs/promises';
const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const index = JSON.parse(await readFile(new URL('../frontend/mirror/index.json', import.meta.url), 'utf8'));
const routes = new Set(index.routes.map(r => r.route));
const paths = [...new Set([...routes, ...index.entries.map(e => e.path)])]
  .filter(p => /\.(js|css|json)$/.test(p) || routes.has(p));

let files = 0, total = 0;
const samples = [];
for (const path of paths) {
  const res = await fetch(`${base}${path}`).catch(() => null);
  if (!res || !res.ok) continue;
  if (!/text|json|javascript/.test(res.headers.get('content-type') || '')) continue;
  const text = (await res.text()).replaceAll('__SKYLIT_GATEWAY_AUTH', '');
  const hits = [...text.matchAll(/Skylit|SKYLIT/g)];
  if (!hits.length) continue;
  files++; total += hits.length;
  if (samples.length < 6) samples.push({ path, around: text.slice(Math.max(0, hits[0].index - 30), hits[0].index + 40).replace(/\s+/g, ' ') });
}
console.log(JSON.stringify({ filesWithUpperBrand: files, totalUpper: total, samples }, null, 2));
