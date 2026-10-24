// Read-only, bounded private-web chart probe. Does not use the official paid API.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:48177';
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const accessToken = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
assert.ok(accessToken);
const result = { time: new Date().toISOString(), runtime: 'wslc',
  companyHasSkylitCredentials: false, fullWebsiteReady: false, observations: [] };
const dir = new URL('./results/', import.meta.url);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const company = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = new Set();
  await company.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    blocked.add(url.host); return route.abort('blockedbyclient');
  });
  await company.routeWebSocket('**/*', ws => ws.close());
  const login = await company.request.post(`${base}/_gateway/login`, {
    headers: { Origin: base }, data: { accessToken },
  });
  assert.ok(login.ok());
  const page = await company.newPage();
  const navigation = await page.goto(`${base}/atlas`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  result.originalAtlasPage = { status: navigation?.status(),
    title: await page.title(), visibleTextCharacters: (await page.locator('body').innerText()).trim().length,
    upstreamAuthStatus: navigation?.headers()['x-clerk-auth-status'] || 'not-reported' };
  await page.screenshot({ path: fileURLToPath(new URL('atlas-proxy.png', dir)), fullPage: false });
  async function fetchLocal(path) {
    return page.evaluate(async path => {
      const response = await fetch(path, { credentials: 'same-origin' });
      const json = (response.headers.get('content-type') || '').includes('application/json');
      return { status: response.status, json, body: json ? await response.json() : null };
    }, path);
  }
  const search = await fetchLocal('/tv/search?query=SPY&limit=1');
  result.observations.push({ name: 'symbol-search', status: search.status,
    json: search.json, resultCount: Array.isArray(search.body) ? search.body.length : null });
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body) && search.body.length === 1);
  const from = 1792675800;
  const to = 1792676100;
  const history = await fetchLocal(`/tv/history?symbol=SPY&resolution=5&from=${from}&to=${to}&extended=true`);
  result.observations.push({ name: 'five-minute-history-window', status: history.status,
    json: history.json, dataStatus: history.body?.s || null,
    barCount: Array.isArray(history.body?.t) ? history.body.t.length : null });
  assert.equal(history.status, 200);
  assert.equal(history.body?.s, 'ok');
  assert.ok(Array.isArray(history.body.t) && history.body.t.length > 0 && history.body.t.length <= 10);
  const count = history.body.t.length;
  for (const key of ['o', 'h', 'l', 'c']) {
    assert.ok(Array.isArray(history.body[key]) && history.body[key].length === count);
    assert.ok(history.body[key].every(Number.isFinite));
  }
  assert.ok(history.body.t.every(t => Number.isFinite(t) && t >= from && t <= to));
  const bad = await fetchLocal(`/tv/history?resolution=5&from=${from}&to=${to}&extended=true`);
  result.observations.push({ name: 'missing-symbol-error-preserved', status: bad.status, json: bad.json });
  assert.equal(bad.status, 400);
  assert.equal(bad.json, false);
  const cookies = await company.cookies();
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, 'skylit_gateway');
  result.directUpstreamHostsBlocked = [...blocked].sort();
  result.privateChartDataThroughRustVerified = true;
  // A 502 diagnostic body is visible text, NOT a successfully rendered original app.
  result.originalAtlasRendered = result.originalAtlasPage.status === 200
    && result.originalAtlasPage.visibleTextCharacters > 0
    && /Skylit/i.test(result.originalAtlasPage.title);
  result.originalAtlasUsabilityVerified = false;
  result.note = 'A bounded history read is not live chart/SSE/WebSocket verification. Original frontend readiness is independent.';
  await company.close();
} catch (_) {
  result.failure = 'Bounded chart assertion failed; raw data, credentials and response bodies intentionally not logged.';
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('chart-probe.json', dir), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
