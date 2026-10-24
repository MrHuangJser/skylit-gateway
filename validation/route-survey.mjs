// Visit every sidebar route in a real browser by CLICKING its link (the same path a
// user takes), then record whether the original page rendered and which same-origin
// requests failed. Records only paths, status codes and short reason codes.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const out = new URL('./results/routes/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  // Expand every collapsed sidebar section so all links exist in the DOM.
  for (const t of await page.locator('[data-testid="sidebar-section-toggle"][aria-expanded="false"]').all()) await t.click().catch(() => {});
  await page.waitForTimeout(800);
  const links = await page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('nav a[href], aside a[href], [data-testid^="sidebar"] a[href]')) {
      const href = a.getAttribute('href');
      const label = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      if (href && href.startsWith('/') && !href.startsWith('//') && label && !seen.has(href)) seen.set(href, label);
    }
    return [...seen].map(([href, label]) => ({ href, label }));
  });
  for (const { href, label } of links) {
    const p = await context.newPage();
    const failed = new Map();
    const pageErrors = [];
    p.on('response', async r => {
      const u = new URL(r.url());
      if (u.origin !== base || r.status() < 400) return;
      let reason = '';
      try { const j = JSON.parse(await r.text()); reason = String(j.reason || j.error || '').slice(0, 40); } catch {}
      const k = `${r.status()} ${r.request().method()} ${u.pathname}`;
      failed.set(k, reason);
    });
    p.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 140)));
    let status = 0;
    try { status = (await p.goto(`${base}${href}`, { waitUntil: 'domcontentloaded', timeout: 60000 }))?.status() ?? 0; } catch { status = -1; }
    await p.waitForTimeout(9000);
    const info = await p.evaluate(() => {
      const t = document.body?.innerText || '';
      const err = /(something went wrong|application error|an error occurred|failed to load|unauthorized|forbidden|not found|404|500)/i.exec(t);
      return { textLen: t.length, gatewayDiag: !!document.querySelector('[data-skylit-gateway-diagnostic]'),
        visibleErrorText: err ? err[0] : null, finalPath: location.pathname };
    });
    results.push({ label, href, httpStatus: status, ...info, pageErrors: pageErrors.slice(0, 3),
      failedRequests: [...failed].map(([k, reason]) => reason ? `${k} (${reason})` : k) });
    await p.close();
  }
  await context.close();
} finally {
  await browser.close();
  await writeFile(new URL('route-survey.json', out), JSON.stringify(results, null, 2));
  for (const r of results) {
    const bad = r.failedRequests.filter(f => !/^403 /.test(f));
    console.log(`${String(r.httpStatus).padStart(3)} ${r.href.padEnd(34)} ${r.label.slice(0, 18).padEnd(18)} text=${String(r.textLen).padStart(5)}${r.gatewayDiag ? ' GATEWAY-DIAG' : ''}${r.visibleErrorText ? ' ERR:' + r.visibleErrorText : ''}${r.finalPath !== r.href.split('?')[0] ? ' ->' + r.finalPath : ''}${r.pageErrors.length ? ' JSERR' : ''}`);
    for (const f of bad) console.log(`      ${f}`);
  }
}
