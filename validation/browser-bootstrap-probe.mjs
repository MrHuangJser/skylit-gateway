// This script intentionally lets only the browser receive the user-approved short JWT.
// Never return the token/profile to Node stdout or write them into an artifact.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.BOOTSTRAP_BASE || 'http://127.0.0.1:48183';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const accessToken = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
const result = { checkedAt: new Date().toISOString(), originalWebsiteVerified: false };
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const entry = await context.request.post(`${base}/_gateway/login`, {
    headers: { Origin: base }, data: { accessToken },
  });
  assert.equal(entry.status(), 204);
  const page = await context.newPage();
  await page.goto(`${base}/_gateway/login`, { waitUntil: 'domcontentloaded' });
  Object.assign(result, await page.evaluate(async () => {
    const response = await fetch('/_gateway/auth/bootstrap', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) return { bootstrapStatus: response.status };
    const data = await response.json();
    // Keep the normal short token scoped inside this browser function only.
    const api = await fetch('/api/access', { credentials: 'same-origin',
      headers: { Authorization: `Bearer ${data.token}` } });
    return { bootstrapStatus: response.status, businessStatusWithBrowserJwt: api.status,
      sourceVerified: data.source === 'upstream-verified', realUserIdPresent: typeof data.user?.id === 'string',
      shortTokenPresent: typeof data.token === 'string' && data.token.split('.').length === 3,
      shortTokenUnexpired: data.expiresAt > Math.floor(Date.now() / 1000),
      fullWebsiteReady: data.fullWebsiteReady,
      noTokenInLocalStorage: !Object.keys(localStorage).some(k => /token|session/i.test(k)),
    };
  }));
  result.noLongUpstreamCookie = (await context.cookies()).every(c => c.name === 'skylit_gateway');
  assert.equal(result.bootstrapStatus, 200);
  assert.equal(result.sourceVerified, true);
  assert.equal(result.realUserIdPresent, true);
  assert.equal(result.shortTokenPresent, true);
  assert.equal(result.shortTokenUnexpired, true);
  assert.equal(result.noLongUpstreamCookie, true);
  assert.equal(result.businessStatusWithBrowserJwt, 200, 'Vendor Bearer plus a valid local gateway cookie must not be mistaken for a wrong gateway access code');
  await context.close();
} catch (_) {
  result.failure = 'Browser bootstrap regression assertion failed; credentials intentionally not logged.';
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('./results/black-screen/browser-bootstrap.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
