// Explicit, dedicated upstream login only. Does not read an existing Chrome profile,
// export credentials, copy cookies, obtain tokens, or start an HTTP/CDP listener.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../.local/', import.meta.url));
await mkdir(root, { recursive: true });
const context = await chromium.launchPersistentContext(`${root}/upstream-profile`, {
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
});
const page = context.pages()[0] || await context.newPage();
const status = `${root}/upstream-login-status.json`;
const save = async state => writeFile(status, JSON.stringify({
  state, checkedAt: new Date().toISOString(),
  gatewaySessionConnected: false,
  note: 'Dedicated browser login is not yet gateway integration.',
}, null, 2));
try {
  await page.goto('https://app.skylit.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await save('waiting-for-manual-login');
  console.log('Dedicated Skylit browser opened. Complete normal login there; do not paste credentials into chat.');
  await page.waitForFunction(() => window.Clerk?.session?.status === 'active', undefined, { timeout: 0 });
  await save('active-session-detected');
  console.log('Dedicated browser reports an active session; credentials were not exported.');
  console.log('Leave the window open for authorized follow-up verification, or close it to exit.');
  await new Promise(resolve => context.once('close', resolve));
} catch (error) {
  await save('closed-or-unavailable');
  // Browser/SDK errors may include URLs or identifiers: intentionally do not print them.
  console.error('Dedicated browser closed or login status unavailable. No credentials exported.');
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
}
