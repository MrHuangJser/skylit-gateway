// Audit the branded output: every served asset is checked for leftover brand text.
// Internal identifiers (`__SKYLIT_GATEWAY_AUTH`), domains (skylit.ai) and the upstream
// repo slug are expected to survive and are excluded.
import { readFile } from 'node:fs/promises';
const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const index = JSON.parse(await readFile(new URL('../frontend/mirror/index.json', import.meta.url), 'utf8'));
const paths = [...index.routes.map(r => r.route), ...index.entries.map(e => e.path)]
  .filter(p => /\.(js|css|json)$/.test(p) || index.routes.some(r => r.route === p));

const ALLOWED = [/__SKYLIT_GATEWAY_AUTH/g, /skylit\.ai/gi, /SkylitAI/g, /skylit-arc-research/g,
  /skylit_gateway/gi, /x-skylit/gi, /data-skylit/gi, /skylit:/gi, /skylit-[a-z-]+/gi];
const findings = [];
let scanned = 0;
for (const path of [...new Set(paths)]) {
  const res = await fetch(`${base}${path}`).catch(() => null);
  if (!res || !res.ok) continue;
  const type = res.headers.get('content-type') || '';
  if (!/text|json|javascript/.test(type)) continue;
  let text = await res.text();
  scanned++;
  for (const pattern of ALLOWED) text = text.replace(pattern, '');
  const hits = [...text.matchAll(/skylit/gi)];
  if (hits.length) findings.push({ path, count: hits.length,
    samples: [...new Set(hits.slice(0, 3).map(m => text.slice(Math.max(0, m.index - 20), m.index + 24).replace(/\s+/g, ' ')))] });
}
console.log(JSON.stringify({ scanned, leftovers: findings.slice(0, 12), clean: findings.length === 0 }, null, 2));
