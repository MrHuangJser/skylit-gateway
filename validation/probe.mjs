import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = 'http://127.0.0.1:48173';
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const token = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
assert.ok(token, 'local gateway test credential must exist');
const out = fileURLToPath(new URL('./results/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const result = {
  time: new Date().toISOString(),
  runtime: 'wslc',
  phase: 'transport-only',
  upstreamSession: false,
  checks: [],
  directUpstreamHostsBlocked: [],
};
async function check(name, fn) {
  await fn();
  result.checks.push({ name, passed: true });
}
try {
  const context = await browser.newContext();
  const blocked = new Set();
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === base || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    blocked.add(u.host);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  await check('health explicitly reports no upstream session', async () => {
    const r = await context.request.get(`${base}/_gateway/health`);
    assert.equal(r.status(), 200);
    const body = await r.json();
    assert.equal(body.upstreamSession, false);
  });
  await check('clean browser receives gateway login, no upstream cookies', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('body').innerText(), /gateway|访问|登录/i);
    assert.equal((await context.cookies()).length, 0);
  });
  await check('invalid local access code rejected', async () => {
    const r = await context.request.post(`${base}/_gateway/login`, {
      headers: { Origin: base }, data: { accessToken: 'wrong-code' },
    });
    assert.equal(r.status(), 401);
  });
  await check('cross-origin login rejected', async () => {
    const r = await context.request.post(`${base}/_gateway/login`, {
      headers: { Origin: 'https://untrusted.invalid' }, data: { accessToken: token },
    });
    assert.equal(r.status(), 403);
  });
  await check('valid local access code creates HttpOnly device session', async () => {
    await page.locator('#token').fill(token);
    const [r] = await Promise.all([
      page.waitForResponse(response => response.url() === `${base}/_gateway/login` && response.request().method() === 'POST'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      page.getByRole('button', { name: '验证本地访问' }).click(),
    ]);
    assert.ok(r.ok());
    const cookies = await context.cookies();
    assert.ok(cookies.some(c => c.httpOnly && c.sameSite === 'Strict'));
  });
  await check('second clean device does not inherit first device access', async () => {
    const second = await browser.newContext();
    try {
      const r = await second.request.get(`${base}/api/access`);
      assert.equal(r.status(), 401);
      assert.equal((await second.cookies()).length, 0);
    } finally { await second.close(); }
  });
  await check('upstream account-changing requests blocked', async () => {
    const r = await context.request.post(`${base}/api/account`, { data: {} });
    assert.equal(r.status(), 403);
  });
  await check('gateway can fetch public upstream HTML', async () => {
    const r = await context.request.get(`${base}/`);
    assert.equal(r.status(), 200);
    assert.match(r.headers()['content-type'] || '', /text\/html/);
    assert.match(await r.text(), /<html/i);
    result.publicPageAuthStatus = r.headers()['x-clerk-auth-status'] || 'not-reported';
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.screenshot({ path: `${out}/transport-only.png`, fullPage: false });
  result.page = { title: await page.title(), visibleTextCharacters: (await page.locator('body').innerText()).trim().length };
  result.fullApplicationRendered = false;
  result.directUpstreamHostsBlocked = [...blocked].sort();
  // A public HTML fetch is not an authenticated Skylit feature test.
  result.authenticatedSkylitVerified = false;
  result.limitation = 'No upstream session connected; no authenticated page, token renewal, SSE or WebSocket success claimed.';
  await check('local logout does not call upstream and revokes local access', async () => {
    const r = await context.request.post(`${base}/_gateway/logout`, { headers: { Origin: base } });
    assert.ok(r.ok());
    const next = await context.request.get(`${base}/api/access`);
    assert.equal(next.status(), 401);
  });
  await context.close();
} catch (error) {
  result.failure = { message: error.message.replaceAll(token, '[REDACTED]') };
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(`${out}/transport-only.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
