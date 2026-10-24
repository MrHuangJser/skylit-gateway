// Print the sidebar's real routes as "label -> href", one per line.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto(`${base}/heatmaps`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const list = await page.evaluate(() => [...document.querySelectorAll('aside a[href], nav a[href]')]
    .map(a => ({ label: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22), href: a.getAttribute('href') }))
    .filter(e => e.href && e.href.startsWith('/')));
  for (const e of list) console.log(`${e.label || '(icon)'} -> ${e.href}`);
} finally { await browser.close(); }
