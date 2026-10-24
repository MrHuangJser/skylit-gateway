// List every sidebar link with its href and whether it is displayed, to confirm
// which items the injected CSS hides and which the original app hides itself.
import { chromium } from 'playwright-core';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  const rows = await page.evaluate(() => {
    const style = document.querySelector('style[data-skylit-gateway-account-hidden]');
    const all = [...document.querySelectorAll('aside[data-component="sidebar"] a[href]')];
    const measure = () => all.map(a => ({ href: a.getAttribute('href'), text: a.innerText.trim().slice(0, 20),
      shown: a.offsetParent !== null && getComputedStyle(a).display !== 'none' }));
    const withCss = measure();
    // Temporarily disable ONLY the gateway style to see what the original app shows.
    if (style) style.disabled = true;
    const withoutCss = measure();
    if (style) style.disabled = false;
    return withCss.map((r, i) => ({ ...r, shownWithoutGatewayCss: withoutCss[i].shown }));
  });
  for (const r of rows) {
    const note = r.shown === r.shownWithoutGatewayCss ? '' : (r.shown ? '' : '  <- hidden by gateway CSS');
    console.log(`${r.shown ? 'SHOWN ' : 'hidden'} ${r.href.padEnd(26)} ${r.text.padEnd(20)}${!r.shownWithoutGatewayCss && !r.shown ? '  (original app also hides it)' : ''}${note}`);
  }
} finally { await browser.close(); }
