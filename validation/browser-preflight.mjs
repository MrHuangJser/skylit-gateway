import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<title>isolated-local-preflight</title><h1>Local browser check</h1>');
  console.log(JSON.stringify({ browser: browser.version(), headlessLaunch: true,
    freshContext: (await context.cookies()).length === 0, title: await page.title(),
    upstreamRequests: 0 }));
  await context.close();
} finally { await browser.close(); }
