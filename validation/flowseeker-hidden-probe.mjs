// Verify the Flowseeker sidebar section is gone, typed /flow/* URLs are blocked, and
// the remaining sidebar sections still render.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const out = {};
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  out.flowseekerHeaderVisible = await page.locator('[aria-controls="sidebar-section-flowseeker"]').first().isVisible().catch(() => false);
  out.visibleFlowLinks = await page.locator('aside[data-component="sidebar"] a[href^="/flow"]').evaluateAll(as => as.filter(a => a.offsetParent !== null).length);
  out.otherSectionsVisible = {};
  for (const s of ['home', 'heatseeker', 'atlas', 'talon', 'nexus']) {
    out.otherSectionsVisible[s] = await page.locator(`[aria-controls="sidebar-section-${s}"]`).first().isVisible().catch(() => null);
  }
  out.sidebarText = (await page.locator('aside[data-component="sidebar"]').innerText()).replace(/\s+/g, ' ').slice(0, 400);
  await page.screenshot({ path: fileURLToPath(new URL('./results/routes/sidebar-no-flowseeker.png', import.meta.url)) });
  out.typedUrls = {};
  for (const p of ['/flow/live', '/flow/scanner', '/flow/tracker']) {
    const r = await (await context.newPage()).goto(`${base}${p}`, { waitUntil: 'domcontentloaded' });
    out.typedUrls[p] = r.status();
  }
} finally {
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
}
