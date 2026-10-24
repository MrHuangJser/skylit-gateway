// Visiting "/" must always land on the default view, even after another page was visited.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const out = new URL('./results/vps/', import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const settle = async () => {
    await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(6000);
    return page.evaluate(() => ({ path: location.pathname + location.search,
      textLength: document.body.innerText.length,
      hasNumbers: /[\d,]{3,}\.\d/.test(document.body.innerText) }));
  };

  const first = await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(settle);
  const afterRoot = await page.goto(`${base}/atlas`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(settle);
  const backToRoot = await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(settle);
  const withQuery = await page.goto(`${base}/?symbol=SPY`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(settle);
  await page.screenshot({ path: fileURLToPath(new URL('root-default.png', out)) });

  const report = { first, afterRoot, backToRoot, withQuery };
  await writeFile(new URL('root-default.json', out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
