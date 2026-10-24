// Verify a deep link renders the right page (not just a shell), and that chart data loads.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const path = process.env.PATH_TO_CHECK || '/atlas';
const name = process.env.SHOT_NAME || 'deep-link';
const out = new URL('./results/vps/', import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const bad = [];
  page.on('response', r => { const u = new URL(r.url());
    if (u.origin === new URL(base).origin && r.status() >= 400) bad.push(`${r.status()} ${u.pathname}`); });
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const timeline = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => -1);
    timeline.push(text);
    if (text > 800) break;
  }
  const state = await page.evaluate(() => ({
    path: location.pathname,
    textLength: document.body.innerText.length,
    hasNumbers: /[\d,]{3,}\.\d/.test(document.body.innerText),
    heading: (document.querySelector('h1,h2,[data-testid]')?.textContent || '').trim().slice(0, 60),
    marker: /ATLAS|TALON|TRINITY|CALENDAR|Gateway frontend diagnostic/i.exec(document.body.innerText)?.[0] ?? null,
  }));
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)) });
  const report = { base, path, state, timeline, bad: [...new Set(bad)].slice(0, 6) };
  await writeFile(new URL(`${name}.json`, out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
