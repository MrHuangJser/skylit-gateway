// Why does a 404-document route show 502 in the browser? Record the document and
// any client-side navigation (RSC fetch) statuses for one route.
import { chromium } from 'playwright-core';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const path = process.env.PEEK_PATH || '/talon';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.origin === base && (u.pathname === path || u.search.includes('_rsc'))) {
      console.log(r.status(), r.request().method(), u.pathname + u.search.slice(0, 40), r.request().headers()['rsc'] ? '(RSC)' : '', r.headers()['content-type'] || '');
    }
  });
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  console.log('TEXT:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300));
} finally { await browser.close(); }
