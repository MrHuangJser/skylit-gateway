// Find WHO loads clerk.browser.js, via CDP request initiator stacks.
import { chromium } from 'playwright-core';
const base = process.env.VPS_BASE || 'https://skylit.tsra.dev';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const hits = [];
  cdp.on('Network.requestWillBeSent', e => {
    if (!/clerk/i.test(e.request.url)) return;
    const frames = e.initiator?.stack?.callFrames ?? [];
    hits.push({ url: e.request.url.slice(0, 80),
      initiator: e.initiator?.type,
      stack: frames.slice(0, 25).map(f => `${(f.url || '').split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1} ${f.functionName || '(anon)'}`),
    });
  });
  await page.goto(`${base}/?symbol=SPXW`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(15000);
  console.log(JSON.stringify(hits, null, 2));
  const clerkLoaded = await page.evaluate(() => typeof window.Clerk);
  console.log('typeof window.Clerk =', clerkLoaded);
} finally { await browser.close(); }
