// /flow/live has no <main>; read body text and screenshot to see what it shows.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(`${base}/flow/live`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
  const nav = text.indexOf('FLOW ALERTS');
  console.log(text.slice(nav > 0 ? nav : 0, (nav > 0 ? nav : 0) + 500));
  await page.screenshot({ path: fileURLToPath(new URL('./results/routes/flow-live.png', import.meta.url)) });
} finally { await browser.close(); }
