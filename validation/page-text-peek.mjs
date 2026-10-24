// Show what a few "short text" pages actually display (first lines only).
import { chromium } from 'playwright-core';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const paths = (process.env.PEEK || '/alerts,/tempest,/flow/live').split(',');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  for (const path of paths) {
    const page = await context.newPage();
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    const text = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return (main.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
    });
    console.log(`== ${path}\n   ${text}`);
    await page.close();
  }
} finally { await browser.close(); }
