// Capture the JS error behind the "RECOVERY" error-boundary screen.
import { chromium } from 'playwright-core';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const path = process.env.PROBE_PATH || '/alerts';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const msgs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`[${m.type()}] ${m.text().slice(0, 600)}`); });
  page.on('pageerror', e => msgs.push(`[pageerror] ${String(e.stack || e.message).slice(0, 900)}`));
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  for (const m of msgs.filter(m => !/Failed to load resource/.test(m))) console.log(m.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[JWT]'), '\n');
} finally { await browser.close(); }
