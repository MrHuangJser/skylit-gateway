// What a dynamic page actually renders: body text, console errors, and key requests.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const path = process.env.PATH_TO_CHECK || '/stages';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 140)));
  page.on('response', r => { const u = new URL(r.url());
    if (u.origin === new URL(base).origin && r.status() >= 400) bad.push(`${r.status()} ${u.pathname}${u.search.slice(0, 30)}`); });
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(18000);
  const info = await page.evaluate(() => ({
    path: location.pathname + location.search,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 420),
    length: document.body.innerText.length,
  }));
  console.log(JSON.stringify({ info, errors: [...new Set(errors)].slice(0, 5), bad: [...new Set(bad)].slice(0, 8) }, null, 2));
} finally { await browser.close(); }
