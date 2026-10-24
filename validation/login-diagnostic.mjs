// Real form repro. Never print access codes, cookie values, or submitted form bodies.
import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const token = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
if (!token) throw new Error('Local test credential unavailable');
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const cases = [
  { name: 'canonical-exact-code', origin: 'http://127.0.0.1:48175', code: token, shouldPass: true },
  { name: 'localhost-exact-code', origin: 'http://localhost:48175', code: token, shouldPass: true },
  { name: 'canonical-copied-env-line', origin: 'http://127.0.0.1:48175', code: `GATEWAY_ACCESS_TOKEN=${token}`, shouldPass: false },
  { name: 'canonical-accidental-spaces', origin: 'http://127.0.0.1:48175', code: ` ${token} `, shouldPass: true },
];
const rows = [];
try {
  for (const c of cases) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === c.origin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    try {
      await page.goto(`${c.origin}/_gateway/login`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.locator('#token').fill(c.code);
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url() === `${c.origin}/_gateway/login` && r.request().method() === 'POST'),
        page.getByRole('button', { name: '验证本地访问' }).click(),
      ]);
      const status = response.status();
      const row = { name: c.name, origin: c.origin, status, shouldPass: c.shouldPass,
        passed: c.shouldPass ? status === 204 : status === 401 };
      if (status !== 204) row.message = await page.locator('#message').innerText();
      rows.push(row);
    } catch (_) { rows.push({ name: c.name, origin: c.origin, unreachable: true, passed: false }); }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
const result = { checkedAt: new Date().toISOString(), cases: rows, allPassed: rows.every(r => r.passed) };
await writeFile(new URL('./results/login-diagnostic.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.allPassed) process.exitCode = 1;
