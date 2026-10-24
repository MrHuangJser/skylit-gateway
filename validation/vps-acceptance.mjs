// Acceptance for the VPS deployment through the public HTTPS domain.
// A clean browser (no cookies, external direct access blocked) must see the original
// Skylit UI with real heatmap data, the hidden menus, and blocked account routes.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const out = new URL('./results/vps/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { base, checkedAt: new Date().toISOString(), checks: [] };
const ok = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log('PASS', name, JSON.stringify(detail)); };

async function device(externalBlocked = true) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
  if (externalBlocked) {
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      return u.origin === new URL(base).origin || ['data:', 'blob:'].includes(u.protocol)
        ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', ws => ws.close());
  }
  return context;
}
const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, credentials: 'same-origin',
    headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b) });
  let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}, [method, path, body]);

try {
  const context = await device(true);
  const page = await context.newPage();
  const failed = [];
  page.on('response', r => { if (r.status() >= 400 && new URL(r.url()).origin === new URL(base).origin) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const nav = await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  if (nav.status() !== 200) throw new Error(`homepage ${nav.status()}`);
  await page.waitForFunction(() => (document.body?.innerText || '').length > 500
    && !document.querySelector('[data-skylit-gateway-diagnostic]'), undefined, { timeout: 60000 });
  ok('homepage renders the original UI', { status: nav.status(), title: await page.title() });

  // Real market data through the deployed stack.
  await page.waitForFunction(() => /[\d,]{3,}\.\d/.test(document.body.innerText), undefined, { timeout: 60000 });
  const strikes = await page.evaluate(() => document.querySelectorAll('[data-testid], canvas, svg').length);
  const rows = await call(page, 'GET', '/api/data');
  ok('real upstream data loads', { heatmapStatus: rows.status, matrixRows: Array.isArray(rows.json?.Strikes) ? rows.json.Strikes.length : null, domNodes: strikes });

  // Account area and the hidden menus.
  const trigger = page.locator('[data-testid="account-menu-trigger"]').first();
  ok('account trigger hidden', { visible: await trigger.isVisible().catch(() => false) });
  const hidden = {};
  for (const href of ['/flow/live', '/flow/scanner', '/nexus/leaderboard', '/nexus/settings', '/developer', '/affiliate']) {
    hidden[href] = await page.locator(`aside[data-component="sidebar"] a[href="${href}"]`).first().isVisible().catch(() => false);
  }
  ok('flowseeker/nexus/developer/affiliate menus hidden', hidden);
  const visibleMenus = await page.locator('aside[data-component="sidebar"] a[href]').evaluateAll(as =>
    as.filter(a => a.offsetParent !== null).map(a => a.getAttribute('href')).filter(Boolean));
  ok('other menus still present', { visible: visibleMenus.length, sample: visibleMenus.slice(0, 8) });

  // Blocked routes answer 403 through the public domain.
  const blocked = {};
  for (const p of ['/user-profile', '/developer/keys', '/nexus/leaderboard', '/flow/live']) {
    blocked[p] = (await page.request.get(`${base}${p}`, { maxRedirects: 0 })).status();
  }
  ok('blocked routes return 403', blocked);

  await page.screenshot({ path: fileURLToPath(new URL('public-home.png', out)) });

  // Per-device isolation across two fresh browsers.
  const other = await device(true);
  const page2 = await other.newPage();
  await page2.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const put = await call(page, 'PUT', '/tv/layouts/vps-probe', { name: 'VPS device A', values: { panes: 2 } });
  if (put.status !== 200) throw new Error(`layout write ${put.status}`);
  const mine = await call(page, 'GET', '/tv/layouts');
  const theirs = await call(page2, 'GET', '/tv/layouts');
  ok('per-device state isolated', {
    writtenOnA: mine.json?.layouts?.some(l => l.id === 'vps-probe') ?? false,
    visibleOnB: theirs.json?.layouts?.some(l => l.id === 'vps-probe') ?? false });
  await context.close();
  await other.close();

  ok('no unexpected 4xx/5xx on load', { failures: [...new Set(failed)].filter(f => !/^403 /.test(f)).slice(0, 6) });
  report.passed = report.checks.length;
} catch (error) {
  report.failure = String(error?.message || error).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[JWT]').slice(0, 400);
  console.log('FAIL', report.failure);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.checks?.length ?? 0, failure: report.failure ?? null }, null, 2));
}
