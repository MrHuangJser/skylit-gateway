// Diagnose what the page actually shows when service workers are allowed.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 180)}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${String(e.message).slice(0, 180)}`));
  page.on('framenavigated', f => { if (f === page.mainFrame()) logs.push(`[nav] ${new URL(f.url()).pathname}`); });
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(18000);
  const info = await page.evaluate(async () => ({
    url: location.href,
    textLen: (document.body?.innerText || '').length,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
    adapter: Boolean(window.__SKYLIT_GATEWAY_AUTH),
    diagnostic: document.querySelector('[data-skylit-gateway-diagnostic]')?.getAttribute('data-skylit-gateway-diagnostic') ?? null,
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    controlled: Boolean(navigator.serviceWorker.controller),
    clerk: typeof window.Clerk,
  }));
  console.log(JSON.stringify(info, null, 2));
  console.log('--- logs');
  for (const l of logs.slice(0, 25)) console.log(l);
} finally { await browser.close(); }
