// Confirm the page's OWN /api/data calls succeed (a bare fetch without parameters 400s).
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const seen = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  page.on('response', async r => {
    const u = new URL(r.url());
    if (u.origin === new URL(base).origin && /^\/api\/data/.test(u.pathname)) {
      let strikes = null;
      try { const j = await r.json(); strikes = Array.isArray(j?.Strikes) ? j.Strikes.length : null; } catch {}
      seen.push({ path: u.pathname, status: r.status(), strikes, query: u.search.slice(0, 60) });
    }
  });
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(15000);
  console.log(JSON.stringify({ calls: seen }, null, 2));
  const good = seen.filter(s => s.status === 200 && (s.strikes ?? 0) > 0);
  console.log('page data calls with real rows:', good.length, good.length ? '' : '<-- PROBLEM');
  if (!good.length) process.exitCode = 1;
} finally { await browser.close(); }
