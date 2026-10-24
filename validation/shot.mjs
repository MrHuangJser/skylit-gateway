// Screenshot the running instance (local or VPS) for visual confirmation.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const name = process.env.SHOT_NAME || 'local-verify';
const out = new URL('./results/vps/', import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { base, errors: [] };
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text().slice(0, 140)); });
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 60000 });
  await page.waitForTimeout(14000);
  report.textLength = await page.evaluate(() => document.body.innerText.length);
  report.heatmapNumbers = await page.evaluate(() => /[\d,]{3,}\.\d/.test(document.body.innerText));
  report.clerkErrors = report.errors.filter(e => /Production Keys|Origin header/i.test(e)).length;
  report.otherErrors = [...new Set(report.errors.filter(e => !/Production Keys|Origin header/i.test(e)))].slice(0, 5);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)) });
  await writeFile(new URL(`${name}.json`, out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
