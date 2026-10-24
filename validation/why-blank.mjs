// List failed requests and uncaught errors for a target, to explain a blank page.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const failed = [], bad = [], errors = [];
  page.on('requestfailed', r => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 110)}`));
  page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname.slice(0, 90)}`); });
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 200)}`); });
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const timeline = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => -1);
    timeline.push({ seconds: (i + 1) * 5, text });
    if (text > 500) break;
  }
  const state = await page.evaluate(() => ({
    text: document.body.innerText.length,
    rootChildren: document.getElementById('__next')?.childElementCount ?? null,
    adapter: Boolean(window.__SKYLIT_GATEWAY_AUTH),
    authState: window.__SKYLIT_GATEWAY_AUTH?.state?.() ?? null,
    scripts: [...document.querySelectorAll('script[src]')].length,
  }));
  console.log(JSON.stringify({ timeline, state, failed: [...new Set(failed)].slice(0, 8), bad: [...new Set(bad)].slice(0, 10),
    errors: [...new Set(errors)].slice(0, 8) }, null, 2));
} finally { await browser.close(); }
