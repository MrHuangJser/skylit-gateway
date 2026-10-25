// Why is a row not visible: computed styles of the row and each ancestor.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'http://127.0.0.1:48190';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto(`${base}/heatmaps`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const report = await page.evaluate(() => {
    const pick = needle => [...document.querySelectorAll('aside a[href="/"]')]
      .find(a => (a.textContent || '').includes(needle));
    const describe = el => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { text: (el.textContent || '').trim().slice(0, 18), display: cs.display, visibility: cs.visibility,
        opacity: cs.opacity, height: Math.round(r.height), width: Math.round(r.width) };
    };
    const chain = el => {
      const out = []; let p = el;
      for (let i = 0; p && i < 7; i++, p = p.parentElement) out.push(describe(p));
      return out;
    };
    const heat = pick('HEATMAPS');
    const dash = pick('DASHBOARD');
    return { heatmaps: describe(heat), heatmapsChain: chain(heat), dashboard: describe(dash) };
  });
  console.log(JSON.stringify(report, null, 1));
} finally { await browser.close(); }
