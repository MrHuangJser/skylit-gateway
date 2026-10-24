// Real-browser acceptance for: no access code, per-device state isolation,
// hidden account area and blocked account routes. Two clean Chrome contexts act
// as two company devices. No credentials, cookies or identities are written out.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48193';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const out = new URL('./results/device-isolation/', import.meta.url);
await mkdir(out, { recursive: true });
const result = { checkedAt: new Date().toISOString(), base, checks: [] };
const pass = (name, detail = {}) => result.checks.push({ name, passed: true, ...detail });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });

async function device(label) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // Company devices cannot reach the upstream directly.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === base || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  const page = await context.newPage();
  const upstreamStateWrites = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin !== base && /layouts|drawings|presets|watchlist|favorites|preferences/.test(u.pathname)) upstreamStateWrites.push(u.pathname);
  });
  return { label, context, page, upstreamStateWrites };
}
// Same-origin fetch from inside the real page, exactly like the original frontend.
const call = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const r = await fetch(path, { method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}, [method, path, body]);

try {
  const a = await device('A');
  const b = await device('B');

  // 1) No access code: a clean browser opens the original site directly.
  const nav = await a.page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.equal(nav.status(), 200);
  assert.ok(!/本地访问码|access token/i.test(await a.page.title()));
  await a.page.waitForFunction(() => (document.body?.innerText || '').length > 500
    && !document.querySelector('[data-skylit-gateway-diagnostic]'), undefined, { timeout: 30000 });
  const cookies = await a.context.cookies();
  assert.ok(cookies.some(c => c.name === 'skylit_gateway' && c.httpOnly), 'device cookie issued automatically');
  assert.ok(!cookies.some(c => /^__client|^__session|^CloudFront-/.test(c.name)));
  const loginNav = await a.page.request.get(`${base}/_gateway/login`, { maxRedirects: 0 });
  assert.equal(loginNav.status(), 302);
  pass('no access code: original page renders and device identity is automatic', {
    visibleTextCharacters: (await a.page.locator('body').innerText()).length });

  // 2) Account area removed from the sidebar.
  await a.page.waitForTimeout(1500);
  const trigger = a.page.locator('[data-testid="account-menu-trigger"]');
  const triggerCount = await trigger.count();
  const triggerVisible = triggerCount > 0 && await trigger.first().isVisible();
  assert.equal(triggerVisible, false, 'account trigger must not be visible');
  const footerAccountVisible = await a.page.evaluate(() => [...document.querySelectorAll('.sidebar-footer-row')]
    .some(row => row.querySelector('[data-testid="account-menu-trigger"]') && getComputedStyle(row).display !== 'none'));
  assert.equal(footerAccountVisible, false);
  await a.page.screenshot({ path: fileURLToPath(new URL('device-a-home.png', out)) });
  pass('account trigger and its sidebar-footer row are hidden', { triggerInDom: triggerCount > 0 });

  // 3) Account/settings routes blocked even when typed directly.
  for (const path of ['/user-profile', '/developer/keys', '/affiliate', '/invite']) {
    const r = await a.page.request.get(`${base}${path}`, { maxRedirects: 0 });
    assert.equal(r.status(), 403, `${path} blocked`);
  }
  assert.equal((await call(a.page, 'GET', '/api/nexus/users/me')).status, 403);
  assert.equal((await call(a.page, 'GET', '/api/developer/keys')).status, 403);
  pass('account and settings pages/APIs return 403 on company devices');

  // 4) Per-device state: writes on A are local to A; B (a different device) sees none.
  await b.page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const lay = await call(a.page, 'PUT', '/tv/layouts/probe-layout', { name: 'Device A layout', values: { panes: 2 } });
  assert.equal(lay.status, 200); assert.equal(lay.json.version, 1);
  const draw = await call(a.page, 'PUT', '/tv/drawings/SPXW', { drawings: [{ id: 'probe-line', tool: 'hline', price: 7600 }] });
  assert.equal(draw.status, 200); assert.equal(draw.json.drawings[0].id, 'probe-line');
  assert.equal((await call(a.page, 'POST', '/api/favorites/SPXW')).status, 200);
  assert.equal((await call(a.page, 'POST', '/api/watchlists', { name: 'Device A list', symbols: ['SPXW'] })).status, 200);

  const aLayouts = await call(a.page, 'GET', '/tv/layouts');
  const bLayouts = await call(b.page, 'GET', '/tv/layouts');
  assert.ok(aLayouts.json.layouts.some(l => l.id === 'probe-layout'));
  assert.ok(!bLayouts.json.layouts.some(l => l.id === 'probe-layout'));
  assert.deepEqual((await call(b.page, 'GET', '/tv/drawings/SPXW')).json.drawings, []);
  assert.ok((await call(a.page, 'GET', '/api/favorites')).json.favorites.includes('SPXW'));
  assert.ok(!(await call(b.page, 'GET', '/api/favorites')).json.favorites.includes('SPXW'));
  assert.ok((await call(a.page, 'GET', '/api/watchlists')).json.watchlists.some(w => w.name === 'Device A list'));
  assert.ok(!(await call(b.page, 'GET', '/api/watchlists')).json.watchlists.some(w => w.name === 'Device A list'));
  assert.deepEqual([...a.upstreamStateWrites, ...b.upstreamStateWrites], []);
  pass('layouts, drawings, favorites and watchlists are isolated per device and stay on the proxy');

  // 5) State survives a reload (same device cookie) and B's own write stays separate.
  await a.page.reload({ waitUntil: 'domcontentloaded' });
  assert.ok((await call(a.page, 'GET', '/tv/layouts')).json.layouts.some(l => l.id === 'probe-layout'));
  assert.equal((await call(b.page, 'PUT', '/tv/layouts/probe-layout', { name: 'Device B layout', values: {} })).json.version, 1);
  const aAfter = (await call(a.page, 'GET', '/tv/layouts')).json.layouts.find(l => l.id === 'probe-layout');
  assert.equal(aAfter.name, 'Device A layout');
  pass('state persists across reload and same layout id on another device does not overwrite');

  // 6) Real market data still reaches the original page.
  const data = await a.page.evaluate(async () => {
    const r = await fetch('/api/symbols', { credentials: 'same-origin' });
    return r.status;
  });
  assert.equal(data, 200);
  pass('protected upstream read data still works without an access code');

  await a.context.close(); await b.context.close();
  result.allPassed = true;
} catch (error) {
  result.failure = String(error?.message || error).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]').slice(0, 600);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('result.json', out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
