// List every failing same-origin request on the main pages, grouped by path and
// status. Only paths/status/short reason codes are recorded, never bodies or tokens.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const pages = (process.env.SURVEY_PAGES || '/atlas?symbol=ES1,/?symbol=SPXW,/trinity,/tempest').split(',');
const out = new URL('./results/perf/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const failures = new Map();
try {
  const context = await browser.newContext();
  for (const p of pages) {
    const page = await context.newPage();
    page.on('response', async r => {
      const u = new URL(r.url());
      if (u.origin !== base || r.status() < 400) return;
      let reason = '';
      try { const t = await r.text(); const j = JSON.parse(t); reason = String(j.reason || j.error || '').slice(0, 40); }
      catch { reason = ''; }
      const key = `${r.request().method()} ${u.pathname} ${r.status()}`;
      const e = failures.get(key) || { method: r.request().method(), path: u.pathname, status: r.status(), reason, count: 0, pages: new Set() };
      e.count++; e.pages.add(p); failures.set(key, e);
    });
    await page.goto(`${base}${p}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(15000);
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
  const list = [...failures.values()].map(e => ({ ...e, pages: [...e.pages] }))
    .sort((a, b) => a.status - b.status || a.path.localeCompare(b.path));
  await writeFile(new URL('failure-survey.json', out), JSON.stringify(list, null, 2));
  for (const e of list) console.log(`${e.status} ${e.method.padEnd(4)} ${e.path.padEnd(58)} x${String(e.count).padEnd(3)} ${e.reason}`);
  console.log(`total distinct=${list.length}`);
}
