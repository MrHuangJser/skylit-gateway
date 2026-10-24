// Reproduce the real-Chrome difference: service workers ALLOWED (earlier probes
// blocked them), optionally with a stale cookie from the old access-code version.
import { chromium } from 'playwright-core';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const out = new URL('./results/device-isolation/', import.meta.url);
await mkdir(out, { recursive: true });
const profileDir = fileURLToPath(new URL('../.local/sw-repro-profile/', import.meta.url));
await rm(profileDir, { recursive: true, force: true });
const result = { checkedAt: new Date().toISOString(), visits: [] };
// Persistent profile so a registered service worker survives between visits,
// exactly like the user's everyday Chrome.
const context = await chromium.launchPersistentContext(profileDir, { headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  if (process.env.STALE_COOKIE === 'true') {
    await context.addCookies([{ name: 'skylit_gateway', value: 'ab'.repeat(32), url: base, httpOnly: true, sameSite: 'Strict' }]);
  }
  for (let visit = 1; visit <= 3; visit++) {
    const page = await context.newPage();
    const boot = [];
    page.on('response', r => {
      if (new URL(r.url()).pathname === '/_gateway/auth/bootstrap') {
        boot.push({ status: r.status(), fromServiceWorker: r.fromServiceWorker() });
      }
    });
    await page.goto(`${base}/atlas?symbol=SPY`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    const diag = await page.locator('[data-skylit-gateway-diagnostic]').count();
    const sw = await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.() ?? []).map(r => r.scope));
    result.visits.push({ visit, bootstrap: boot, diagnosticShown: diag > 0,
      text: (await page.locator('body').innerText()).slice(0, 120), serviceWorkers: sw });
    await page.close();
  }
} finally {
  await context.close();
  await rm(profileDir, { recursive: true, force: true });
  await writeFile(new URL('sw-repro.json', out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
