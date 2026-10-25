// Dump the sidebar structure (sections, headers, items) so hiding can target exactly one.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto(`${base}/heatmaps`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 800, undefined, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const tree = await page.evaluate(() => {
    const sidebar = document.querySelector('aside');
    if (!sidebar) return null;
    const items = [...sidebar.querySelectorAll('a[href], [aria-controls]')].map(el => {
      const li = el.closest('li');
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        href: el.getAttribute('href'),
        ariaControls: el.getAttribute('aria-controls'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        inLi: Boolean(li),
        liParentTag: li?.parentElement?.tagName.toLowerCase() ?? null,
        liParentClass: (li?.parentElement?.className || '').toString().slice(0, 60),
        section: (() => {
          const block = el.closest('div.mt-6, div');
          const btn = block?.querySelector(':scope > div > [aria-controls]');
          return btn?.getAttribute('aria-controls') ?? null;
        })(),
        visible: el.offsetParent !== null && el.getBoundingClientRect().height > 0,
      };
    });
    return { items };
  });
  console.log(JSON.stringify(tree, null, 1));
} finally { await browser.close(); }
