// Collect the app's own routes and any failing data calls, so the snapshot can cover them.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const bad = [];
  page.on('response', r => { const u = new URL(r.url());
    if (u.origin === new URL(base).origin && r.status() >= 400) bad.push(`${r.status()} ${u.pathname}${u.search.slice(0, 40)}`); });
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 });
  await page.waitForTimeout(12000);
  const hrefs = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/"]')]
    .map(a => a.getAttribute('href')).filter(h => h && !h.startsWith('/_') && !h.includes('?')))].sort());
  const dataCalls = await page.evaluate(async () => {
    const r = await fetch('/api/data?symbol=SPXW&max_strikes=20&max_expirations=2', { credentials: 'same-origin' });
    const j = await r.json().catch(() => null);
    return { status: r.status, strikes: Array.isArray(j?.Strikes) ? j.Strikes.length : null,
      hasValues: JSON.stringify(j ?? {}).length };
  });
  console.log(JSON.stringify({ hrefs, dataCalls, bad: [...new Set(bad)].slice(0, 12) }, null, 2));
} finally { await browser.close(); }
