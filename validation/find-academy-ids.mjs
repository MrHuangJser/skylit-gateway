// Find the API the academy page uses and any item ids it exposes.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const api = [];
  page.on('response', async r => {
    const u = new URL(r.url());
    if (u.origin === new URL(base).origin && /academy|course|lesson/i.test(u.pathname + u.search)) {
      let snippet = '';
      try { snippet = (await r.text()).slice(0, 160); } catch {}
      api.push({ path: u.pathname + u.search.slice(0, 40), status: r.status(), snippet });
    }
  });
  await page.goto(`${base}/academy`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(9000);
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/academy/"]')]
    .map(a => a.getAttribute('href')).filter(Boolean).slice(0, 8));
  console.log(JSON.stringify({ links, api: api.slice(0, 8) }, null, 1));
} finally { await browser.close(); }
