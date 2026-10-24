import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.GATEWAY_BASE || 'http://127.0.0.1:48177';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, 'Only local gateway test endpoints are allowed');
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const accessToken = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
const snapshot = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
assert.ok(snapshot.expiresAt < Math.floor(Date.now() / 1000), 'Run this check only after the helper has stopped and its snapshot has expired');
const result = { time: new Date().toISOString(), phase: 'expired-session-fail-closed', checks: [] };
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const company = await browser.newContext({ serviceWorkers: 'block' });
  const page = await company.newPage();
  await page.goto(`${base}/_gateway/login`, { waitUntil: 'domcontentloaded' });
  const login = await company.request.post(`${base}/_gateway/login`, {
    headers: { Origin: base }, data: { accessToken },
  });
  assert.ok(login.ok());
  for (const path of ['/api/access', '/tv/history?symbol=SPY']) {
    const response = await page.evaluate(async path => {
      const r = await fetch(path, { credentials: 'same-origin' });
      return { status: r.status, body: await r.text() };
    }, path);
    assert.equal(response.status, 503);
    assert.equal(response.body, 'Upstream session unavailable');
    result.checks.push({ name: `expired snapshot rejects ${path.split('?')[0]}`, passed: true, status: response.status });
  }
  const second = await browser.newContext();
  try {
    assert.equal((await second.request.get(`${base}/api/access`)).status(), 401);
    result.checks.push({ name: 'unapproved device remains unauthorized', passed: true });
  } finally { await second.close(); }
  const health = await company.request.get(`${base}/_gateway/health`);
  assert.equal(health.status(), 200);
  assert.equal((await health.json()).upstreamSession, false);
  result.checks.push({ name: 'health does not misrepresent expired upstream login', passed: true });
  await company.close();
  result.failureModeVerified = true;
} catch (_) {
  result.failure = 'Fail-closed assertion failed; raw credentials and responses intentionally not logged.';
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('./results/fail-closed.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
