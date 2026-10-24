// Reproduce: one transient bootstrap failure must not leave the page stuck on the
// "Gateway authentication unavailable" diagnostic. Fails the first bootstrap only.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const out = new URL('./results/device-isolation/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const result = { checkedAt: new Date().toISOString() };
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let attempts = 0;
  await context.route(`${base}/_gateway/auth/bootstrap`, route => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 503, body: 'Upstream verification unavailable' }) : route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let recovered = false;
  try {
    await page.waitForFunction(() => (document.body?.innerText || '').length > 500
      && !document.querySelector('[data-skylit-gateway-diagnostic]'), undefined, { timeout: 30000 });
    recovered = true;
  } catch {}
  result.bootstrapAttempts = attempts;
  result.recoveredWithoutManualReload = recovered;
  result.stuckOnDiagnostic = await page.locator('[data-skylit-gateway-diagnostic]').count() > 0;
  await context.close();
  if (!recovered) process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('bootstrap-failure-repro.json', out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
