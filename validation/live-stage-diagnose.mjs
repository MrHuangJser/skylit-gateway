// Diagnose a live stage page: which requests fail, and whether the gateway blocked them.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const path = process.env.PATH_TO_CHECK || '/stages';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const bad = [], failed = [], sockets = [], errors = [];
  page.on('response', async r => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    let body = '';
    try { body = (await r.text()).slice(0, 80); } catch {}
    bad.push({ status: r.status(), path: u.pathname + u.search.slice(0, 50), origin: u.origin,
      blockedByGateway: /blocked|Blocked/.test(body), body });
  });
  page.on('requestfailed', r => failed.push(`${r.failure()?.errorText} ${new URL(r.url()).pathname.slice(0, 80)}`));
  page.on('websocket', ws => sockets.push(ws.url().replace(/\?.*$/, '')));
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 120)));
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(20000);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
  console.log(JSON.stringify({ path, text, bad: bad.slice(0, 15), failed: [...new Set(failed)].slice(0, 10),
    sockets: [...new Set(sockets)].slice(0, 6), errors: [...new Set(errors)].slice(0, 5) }, null, 1));
} finally { await browser.close(); }
