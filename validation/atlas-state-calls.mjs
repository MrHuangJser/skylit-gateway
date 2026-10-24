// Observe the ORIGINAL frontend's own per-device state calls on the Atlas page.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48193';
const out = new URL('./results/device-isolation/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const calls = [], errors = [];
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.origin === base && /^\/(tv\/(layouts|drawings|presets|watchlist-order)|api\/(watchlists|favorites)|siren\/preferences)/.test(u.pathname)) {
      calls.push({ method: r.request().method(), path: u.pathname, status: r.status() });
    }
  });
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`${base}/atlas?symbol=SPY`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(15000);
  await page.screenshot({ path: new URL('atlas.png', out).pathname.replace(/^\/(\w:)/, '$1') });
  await context.close();
} finally {
  await browser.close();
  const result = { calls, failing: calls.filter(c => c.status >= 400), pageErrors: errors };
  await writeFile(new URL('atlas-state-calls.json', out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
