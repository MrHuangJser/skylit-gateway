// Owner's choice: the Talon disclaimer must never appear on any company device.
// Checks two brand-new devices, plus a reload, and that nothing is POSTed for it.
import { chromium } from 'playwright-core';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const dialogVisible = page => page.getByText('Disclaimer & Acknowledgement').isVisible().catch(() => false);
const result = {};
try {
  for (const device of ['device-1', 'device-2']) {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
    await page.goto(`${base}/talon`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    const first = await dialogVisible(page);
    const talonReady = await page.getByPlaceholder(/Ask Talon/i).isVisible().catch(() => false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    result[device] = { dialogOnFirstVisit: first, dialogAfterReload: await dialogVisible(page), talonInputVisible: talonReady, pageErrors: errors };
  }
} finally {
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
  const ok = Object.values(result).every(r => !r.dialogOnFirstVisit && !r.dialogAfterReload && r.talonInputVisible && !r.pageErrors.length);
  console.log('ALL OK =', ok);
  if (!ok) process.exitCode = 1;
}
