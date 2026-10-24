// Tests only the existing dedicated profile, never the user's everyday Chrome profile.
// No credentials are written or logged. /api/access is account-access metadata, not a paid data API.
import { chromium, request } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const profile = fileURLToPath(new URL('../.local/upstream-profile', import.meta.url));
const out = fileURLToPath(new URL('./results/', import.meta.url));
await mkdir(out, { recursive: true });
const result = { time: new Date().toISOString(), phase: 'upstream-session-feasibility',
  credentialsExported: false, checks: [] };
let context;
let api;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://app.skylit.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.Clerk?.session?.status === 'active', undefined, { timeout: 30000 });
  result.dedicatedSessionActive = true;
  // Keep the token and identity entirely in this intermediary process's memory.
  const session = await page.evaluate(async () => ({
    token: await window.Clerk.session.getToken(), userId: window.Clerk.user?.id,
  }));
  if (!session.token || !session.userId) throw new Error('No usable session');
  const cookies = await context.cookies('https://app.skylit.ai/api/access');
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const variants = [
    ['no-auth-control', {}],
    ['bearer-only', { Authorization: `Bearer ${session.token}` }],
    ['bearer-and-browser-cookies', { Authorization: `Bearer ${session.token}`, Cookie: cookie }],
  ];
  for (const [name, headers] of variants) {
    // Independent cookie jars keep the no-auth and Bearer-only controls honest.
    api = await request.newContext({ timeout: 20000, ignoreHTTPSErrors: false });
    const response = await api.get('https://app.skylit.ai/api/access', {
      headers, maxRedirects: 0, maxRetries: 0,
    });
    const row = { name, status: response.status(), identityMatches: false };
    if ((response.headers()['content-type'] || '').includes('application/json')) {
      const body = await response.json();
      row.identityMatches = typeof body.user_id === 'string' && body.user_id === session.userId;
      row.applicationEnabled = body.application === true;
    }
    result.checks.push(row);
    await api.dispose();
    api = undefined;
  }
  result.serverSideSessionReuseObserved = result.checks.some(c => c.identityMatches && c.status === 200);
  result.companyBrowserAuthenticatedPageVerified = false;
  result.note = 'Successful metadata requests do not prove token renewal, edge cookies, full page, SSE or WebSocket compatibility.';
} catch (_) {
  result.failure = 'Dedicated headless session or controlled metadata check unavailable; no credentials logged.';
  process.exitCode = 1;
} finally {
  if (api) await api.dispose();
  if (context) await context.close();
  await writeFile(`${out}/session-probe.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
