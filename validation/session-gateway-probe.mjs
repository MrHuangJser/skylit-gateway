import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:48175';
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const accessToken = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
assert.ok(accessToken);
const results = new URL('./results/', import.meta.url);
await mkdir(results, { recursive: true });
const windowMeta = JSON.parse(await readFile(new URL('./results/session-window.json', import.meta.url), 'utf8'));
const result = { time: new Date().toISOString(), runtime: 'wslc',
  phase: 'session-adapter-probe', checks: [], fullWebsiteReady: false,
  companyHasSkylitSession: false };
const browser = await chromium.launch({
  headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const blockedHosts = new Set();
async function check(name, fn) { await fn(); result.checks.push({ name, passed: true }); }
try {
  const company = await browser.newContext({ serviceWorkers: 'block' });
  await company.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    blockedHosts.add(url.host);
    return route.abort('blockedbyclient');
  });
  await company.routeWebSocket('**/*', ws => ws.close());
  const page = await company.newPage();
  await check('upstream session does not grant an unauthenticated device access', async () => {
    const response = await company.request.get(`${base}/api/access`);
    assert.equal(response.status(), 401);
    assert.equal((await company.cookies()).length, 0);
  });
  await page.goto(`${base}/_gateway/login`, { waitUntil: 'domcontentloaded' });
  await check('company signs in only to local gateway through real browser form', async () => {
    await page.locator('#token').fill(accessToken);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url() === `${base}/_gateway/login` && r.request().method() === 'POST'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      page.getByRole('button', { name: '验证本地访问' }).click(),
    ]);
    assert.ok(response.ok());
    const cookies = await company.cookies();
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'skylit_gateway');
    assert.ok(cookies[0].httpOnly);
    assert.equal(cookies[0].domain, '127.0.0.1');
  });
  await check('Rust reports limited session capabilities without claiming full website support', async () => {
    const response = await company.request.get(`${base}/_gateway/capabilities`);
    assert.equal(response.status(), 200);
    const data = await response.json();
    assert.equal(data.fullWebsiteReady, false);
    assert.doesNotMatch(JSON.stringify(data), /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
  });
  let firstIdentity;
  await check('company browser reads protected account metadata through Rust without upstream credentials', async () => {
    // This runs inside the actual company browser, not its Node HTTP helper.
    const data = await page.evaluate(async () => {
      const response = await fetch('/api/access', { credentials: 'same-origin' });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(data.status, 200);
    assert.equal(data.body.application, true);
    assert.equal(typeof data.body.user_id, 'string');
    firstIdentity = data.body.user_id;
    assert.doesNotMatch(JSON.stringify(data.body), /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
    assert.ok(!Object.keys(data.body).some(k => /token|cookie|authorization/i.test(k)));
    result.applicationEnabled = true;
    result.afterFirstAdvertisedExpiry = Math.floor(Date.now() / 1000) > windowMeta.firstAdvertisedExpiry;
  });
  await check('second clean device requires its own local session and resolves to same authorized account', async () => {
    const second = await browser.newContext({ serviceWorkers: 'block' });
    try {
      let response = await second.request.get(`${base}/api/access`);
      assert.equal(response.status(), 401);
      response = await second.request.post(`${base}/_gateway/login`, {
        headers: { Origin: base }, data: { accessToken },
      });
      assert.ok(response.ok());
      response = await second.request.get(`${base}/api/access`);
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).user_id, firstIdentity);
      const logout = await second.request.post(`${base}/_gateway/logout`, { headers: { Origin: base } });
      assert.ok(logout.ok());
      assert.equal((await second.request.get(`${base}/api/access`)).status(), 401);
      assert.equal((await company.request.get(`${base}/api/access`)).status(), 200);
    } finally { await second.close(); }
  });
  result.upstreamMetadataThroughRustVerified = true;
  result.directUpstreamHostsBlocked = [...blockedHosts].sort();
  result.note = 'Metadata access through Rust is verified; original frontend, charts, edge cookies, SSE and WebSocket remain unverified.';
  await company.close();
} catch (_) {
  result.failure = 'Session gateway assertion failed; raw upstream data and credentials intentionally not logged.';
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('session-gateway.json', results), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
