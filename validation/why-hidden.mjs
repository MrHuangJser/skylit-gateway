// Find which injected rule hides the "/" links: toggle our style block off and compare.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto(`${base}/heatmaps`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const report = await page.evaluate(() => {
    const sel = 'aside a[href="/"]';
    const read = () => [...document.querySelectorAll(sel)].map(a => ({
      label: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      visible: a.offsetParent !== null && a.getBoundingClientRect().height > 0,
      parents: (() => { const out = []; let p = a.parentElement; for (let i = 0; p && i < 6; i++, p = p.parentElement) out.push(`${p.tagName.toLowerCase()}${p.className ? '.' + String(p.className).split(' ').slice(0, 2).join('.') : ''}`); return out; })(),
    }));
    const before = read();
    const style = document.querySelector('style[data-skylit-gateway-account-hidden]');
    const css = style ? style.textContent : '';
    if (style) style.remove();
    const after = read();
    return { before, after, cssLength: css.length };
  });
  console.log(JSON.stringify(report, null, 1));
} finally { await browser.close(); }
