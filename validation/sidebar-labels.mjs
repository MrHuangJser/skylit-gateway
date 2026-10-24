// List sidebar entries with their labels and hrefs, plus what the app does at "/".
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(15000);
  const entries = await page.evaluate(() => [...document.querySelectorAll('aside a[href], nav a[href]')]
    .map(a => ({ label: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28),
      href: a.getAttribute('href') })).filter(e => e.href && !e.href.startsWith('/_')));
  console.log(JSON.stringify({ path: new URL(page.url()).pathname, entries }, null, 2));
  // What does the app do when it lands on "/" after visiting another page?
  await page.goto(`${base}/atlas`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  const atlasPath = await page.evaluate(() => location.pathname);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  const homePath = await page.evaluate(() => location.pathname);
  console.log(JSON.stringify({ atlasPath, afterRootVisit: homePath }));
} finally { await browser.close(); }
