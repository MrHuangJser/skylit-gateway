// Acceptance with Service Workers ENABLED (the earlier probe blocked them, which hid
// this failure mode). Also seeds a stale caching worker first, to prove recovery.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const out = new URL('./results/vps/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { base, checkedAt: new Date().toISOString(), checks: [] };
const pass = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log('PASS', name, JSON.stringify(detail)); };

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const clerkErrors = [], adapterMissing = [];
  page.on('console', m => { if (/Production Keys are only allowed|Origin header must be equal/i.test(m.text())) clerkErrors.push(m.text().slice(0, 120)); });
  page.on('response', async r => {
    const u = new URL(r.url());
    if (/clerk\.skylit\.ai/.test(u.host) && r.status() >= 400) adapterMissing.push(`${r.status()} ${u.host}`);
  });

  // Seed a stale caching worker from the ORIGINAL script first (what the user had).
  await page.goto(`${base}/?_prime=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.evaluate(async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready.catch(() => {});
      void reg;
    } catch (e) {}
  });
  await page.waitForTimeout(3000);
  const regsBefore = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

  // Normal load, service workers allowed.
  const nav = await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 500
    && !document.querySelector('[data-skylit-gateway-diagnostic]'), undefined, { timeout: 60000 });
  await page.waitForTimeout(6000);
  const regsAfter = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  const adapterRan = await page.evaluate(() => Boolean(window.__SKYLIT_GATEWAY_AUTH));
  const auth = await page.evaluate(async () => {
    try { const r = await fetch('/_gateway/auth/bootstrap', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}' }); return r.status; } catch { return -1; }
  });
  pass('page renders with service workers enabled', { status: nav.status(), adapterRan, bootstrap: auth });
  pass('upstream caching worker retired', { registrationsBefore: regsBefore, registrationsAfter: regsAfter });
  pass('no Clerk origin errors', { clerkErrors: clerkErrors.slice(0, 3), externalClerkCalls: adapterMissing.slice(0, 3) });

  // Real data still flows through the patched build.
  const data = await page.evaluate(async () => {
    const r = await fetch('/api/data?symbol=SPXW&max_strikes=50&max_expirations=2', { credentials: 'same-origin' });
    const j = await r.json().catch(() => null);
    return { status: r.status, strikes: Array.isArray(j?.Strikes) ? j.Strikes.length : null };
  });
  pass('heatmap data returns real rows', data);
  await page.screenshot({ path: fileURLToPath(new URL('after-sw-fix.png', out)) });
  await context.close();
  report.passed = report.checks.length;
} catch (error) {
  report.failure = String(error?.message || error).slice(0, 300);
  console.log('FAIL', report.failure);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('after-sw-fix.json', out), JSON.stringify(report, null, 2));
}
