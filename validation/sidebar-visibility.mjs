// Which sidebar entries are actually visible, grouped, so a hidden menu is verifiable.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto(`${base}/heatmaps`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const visible = await page.evaluate(() => [...document.querySelectorAll('aside a[href], nav a[href]')]
    // The sidebar is position:fixed, so offsetParent is null for its children; use layout.
    .filter(a => getComputedStyle(a).display !== 'none' && a.getBoundingClientRect().height > 0)
    .map(a => ({ label: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22), href: a.getAttribute('href') }))
    .filter(e => e.href && e.href.startsWith('/')));
  const hidden = await page.evaluate(() => [...document.querySelectorAll('aside a[href], nav a[href]')]
    .filter(a => getComputedStyle(a).display === 'none' || a.getBoundingClientRect().height === 0)
    .map(a => a.getAttribute('href')).filter(h => h && h.startsWith('/')));
  console.log(JSON.stringify({ visible, hidden: [...new Set(hidden)] }, null, 2));
} finally { await browser.close(); }
