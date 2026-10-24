// Measure where page time goes. "first" is a brand-new browser; "repeat" reloads in
// the SAME browser profile, so it shows the effect of browser caching like a user's
// second visit.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const out = new URL('./results/perf/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const classify = p => p.startsWith('/_next/static/') ? 'static' : p === '/api/data' || p === '/api/data/range' ? 'data'
  : /^\/(tv\/(layouts|drawings|presets|watchlist-order)|api\/(watchlists|favorites)|siren\/preferences)/.test(p) ? 'device-local'
  : p.startsWith('/_gateway/') ? 'gateway' : /^\/(api|tv|siren|agent-gateway)\//.test(p) ? 'api' : 'page';
const result = { base, loads: [] };
try {
  const context = await browser.newContext();
  for (const label of ['first', 'repeat']) {
    const page = await context.newPage();
    const entries = [];
    page.on('requestfinished', async r => {
      const u = new URL(r.url());
      if (u.origin !== base) return;
      const t = r.timing();
      const resp = await r.response();
      entries.push({ path: u.pathname, cls: classify(u.pathname), ttfb: Math.round(t.responseStart - t.requestStart),
        fromCache: resp ? resp.fromServiceWorker() || (t.responseStart <= 0) : false,
        bytes: (await r.sizes().catch(() => null))?.responseBodySize ?? 0 });
    });
    const t0 = Date.now();
    await page.goto(`${base}/atlas?symbol=SPY`, { waitUntil: 'load', timeout: 120000 });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(8000);
    const byClass = {};
    for (const e of entries) {
      const c = byClass[e.cls] ||= { count: 0, ttfbSum: 0, maxTtfb: 0, bytes: 0, cacheHits: 0 };
      c.count++; c.ttfbSum += Math.max(0, e.ttfb); c.bytes += e.bytes; c.maxTtfb = Math.max(c.maxTtfb, e.ttfb);
      if (e.fromCache) c.cacheHits++;
    }
    for (const c of Object.values(byClass)) c.avgTtfb = Math.round(c.ttfbSum / c.count);
    result.loads.push({ label, loadEventMs: loadMs, requests: entries.length, byClass });
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
  await writeFile(new URL('perf.json', out), JSON.stringify(result, null, 2));
  for (const l of result.loads) {
    console.log(`== ${l.label}: load=${l.loadEventMs}ms gateway-requests=${l.requests}`);
    for (const [k, c] of Object.entries(l.byClass)) console.log(`  ${k.padEnd(13)} n=${String(c.count).padStart(3)} cached=${String(c.cacheHits).padStart(3)} avgTTFB=${String(c.avgTtfb).padStart(5)}ms maxTTFB=${String(c.maxTtfb).padStart(5)}ms KB=${Math.round(c.bytes / 1024)}`);
  }
}
