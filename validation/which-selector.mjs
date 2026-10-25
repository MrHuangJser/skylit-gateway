// Which of our injected selectors actually match the HEATMAPS row?
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
    const row = [...document.querySelectorAll('aside a[href="/"]')]
      .find(a => (a.textContent || '').includes('HEATMAPS'));
    if (!row) return { error: 'not found' };
    const matches = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText || !rule.style?.display) continue;
        for (const selector of rule.selectorText.split(',')) {
          const sel = selector.trim();
          try { if (row.matches(sel)) matches.push({ sel, display: rule.style.display }); } catch {}
        }
      }
    }
    return { matches, text: (row.textContent || '').trim().slice(0, 20) };
  });
  console.log(JSON.stringify(report, null, 1));
} finally { await browser.close(); }
