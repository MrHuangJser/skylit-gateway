// Actual original homepage visibility loop, not an API-only or substitute-page test.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const base = process.env.BLACKSCREEN_BASE || 'http://127.0.0.1:48175';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const variant = process.env.BLACKSCREEN_VARIANT || 'repro';
assert.match(variant, /^[a-z0-9-]+$/);
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const token = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
assert.ok(token);
const out = new URL('./results/black-screen/', import.meta.url);
await mkdir(out, { recursive: true });
const safeUrl = value => {
  try {
    const u = new URL(value);
    if (u.hostname === 'img.clerk.com' || (u.origin !== base && u.pathname.length > 180)) return `${u.origin}/[redacted-resource]`;
    return `${u.origin}${u.pathname}`;
  } catch { return '[non-URL]'; }
};
const sanitize = value => String(value).replaceAll(token, '[REDACTED]')
  .replace(/https?:\/\/[^\s"'<>]+/g, safeUrl)
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED-EMAIL]')
  .replace(/\b(?:user|sess)_[A-Za-z0-9]+\b/g, '[REDACTED-ID]')
  .slice(0, 700);
const result = { observedAt: new Date().toISOString(), errors: [], failedRequests: [], failedResponses: [], clerkErrors: [], fetchResponses: [], streamResponses: [], bootstrapRequests: 0 };
const responseDetails = [];
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blockedHosts = new Set();
  if (process.env.BLACKSCREEN_BLOCK_EXTERNAL === 'true') {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      blockedHosts.add(url.host);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', ws => ws.close());
  }
  await context.route(`${base}/_gateway/auth/bootstrap`, route => {
    result.bootstrapRequests++;
    if (result.bootstrapRequests > 20) return route.abort('blockedbyclient');
    return route.continue();
  });
  const login = await context.request.post(`${base}/_gateway/login`, {
    headers: { Origin: base }, data: { accessToken: token },
  });
  assert.equal(login.status(), 204);
  const page = await context.newPage();
  page.on('pageerror', error => result.errors.push({ type: 'pageerror', message: sanitize(error.message) }));
  page.on('console', message => {
    if (message.type() === 'error') result.errors.push({ type: 'console', message: sanitize(message.text()) });
  });
  page.on('requestfailed', request => result.failedRequests.push({ url: safeUrl(request.url()),
    reason: sanitize(request.failure()?.errorText || 'unknown') }));
  page.on('response', response => {
    if (response.request().resourceType() === 'eventsource' && result.streamResponses.length < 10) {
      result.streamResponses.push({ url: safeUrl(response.url()), status: response.status(),
        contentType: response.headers()['content-type'] || null });
    }
    if (['fetch', 'xhr'].includes(response.request().resourceType()) && new URL(response.url()).origin === base && result.fetchResponses.length < 80) {
      const request = response.request();
      if (new URL(response.url()).pathname === '/api/sse/ticket') {
        result.ticketRequestShape = { contentType: request.headers()['content-type'] || null,
          bodyBytes: request.postDataBuffer()?.length || 0 };
      }
      result.fetchResponses.push({ url: safeUrl(response.url()), method: request.method(), status: response.status(),
        authorizationPresent: Boolean(request.headers()['authorization']) });
    }
    if (response.status() >= 400) result.failedResponses.push({ url: safeUrl(response.url()), status: response.status() });
    if (response.status() === 400 && new URL(response.url()).hostname === 'clerk.skylit.ai') {
      responseDetails.push((async () => {
        try {
          const data = await response.json();
          result.clerkErrors.push({ url: safeUrl(response.url()),
            requestOrigin: await response.request().headerValue('origin'),
            errors: Array.isArray(data.errors) ? data.errors.map(e => ({
              code: sanitize(e.code), message: sanitize(e.long_message || e.message),
            })) : [],
          });
        } catch { result.clerkErrors.push({ bodyUnavailable: true }); }
      })());
    }
  });
  const pagePath = process.env.BLACKSCREEN_PAGE_PATH || '/';
  assert.ok(pagePath.startsWith('/') && !pagePath.startsWith('//') && new URL(pagePath, base).origin === base);
  const dataWait = process.env.BLACKSCREEN_REQUIRE_DATA === 'true' ? page.waitForResponse(response =>
    new URL(response.url()).origin === base && new URL(response.url()).pathname === '/api/data' && response.status() === 200,
    { timeout: 25000 }).then(async response => {
      const data = await response.json();
      return { status: response.status(), strikeCount: Array.isArray(data.Strikes) ? data.Strikes.length : 0,
        matrixRows: Array.isArray(data.GammaValues) ? data.GammaValues.length : 0,
        finiteSpot: typeof data.CurrentSpot === 'number' && Number.isFinite(data.CurrentSpot) };
    }).catch(() => null) : null;
  const response = await page.goto(new URL(pagePath, base).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  result.httpStatus = response?.status();
  result.title = await page.title();
  // A bounded condition-based wait: this is the actual bug signal, not a sleep on a job.
  try {
    await page.waitForFunction(() => {
      const text = (document.body?.innerText || '').trim();
      return text.length >= 80 && !document.querySelector('[data-skylit-gateway-diagnostic]')
        && !/Please sign in with your authorized account|Access Required/.test(text);
    }, undefined, { timeout: 12000 });
  } catch { /* Record the actual visibility result and fail below. */ }
  if (dataWait) {
    result.heatmapData = await dataWait;
    try {
      await page.waitForFunction(() => !/Select a symbol to view heatmap data|No data available/.test(document.body?.innerText || ''),
        undefined, { timeout: 8000 });
    } catch { /* An empty real chart is a failure, not a substitute for data rendering. */ }
  }
  const body = (await page.locator('body').innerText()).trim();
  result.visibleTextCharacters = body.length;
  result.gatewayDiagnosticElements = await page.locator('[data-skylit-gateway-diagnostic]').count();
  result.originalPageVisible = body.length >= 80 && /Skylit/i.test(result.title)
    && result.gatewayDiagnosticElements === 0
    && !/transport-only|session-adapter-probe|Upstream session unavailable|Please sign in with your authorized account|Access Required/.test(body);
  result.scriptResources = await page.locator('script[src]').evaluateAll(nodes => ({
    localCount: nodes.filter(n => new URL(n.src).origin === location.origin).length,
    external: nodes.filter(n => new URL(n.src).origin !== location.origin).map(n => {
      const u = new URL(n.src); return `${u.origin}${u.pathname}`;
    }),
  }));
  await Promise.all(responseDetails);
  result.blockedExternalHosts = [...blockedHosts].sort();
  result.renderedNavigationRegions = await page.locator('nav, aside, header').count();
  result.knownOriginalProductText = /Heatseeker|Atlas|Flowseeker|Tempest/i.test(body);
  result.emptyHeatmapMessage = /Select a symbol to view heatmap data|No data available/.test(body);
  result.canvasCount = await page.locator('canvas').count();
  const cookieNames = (await context.cookies()).map(cookie => cookie.name);
  result.noLongUpstreamCookies = !cookieNames.some(name => /^CloudFront-|^__client|^__session/.test(name));
  result.noStoredJwtObserved = await page.evaluate(() => !Object.values(localStorage).some(value =>
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)));
  await page.screenshot({ path: fileURLToPath(new URL(`${variant}.png`, out)), fullPage: false });
  await context.close();
  assert.equal(result.httpStatus, 200, 'Original homepage must return HTTP 200');
  assert.equal(result.originalPageVisible, true, 'Original Skylit homepage is blank or not usable: visible original-page text must appear');
  assert.ok(result.renderedNavigationRegions > 0 && result.knownOriginalProductText, 'Original navigation and product labels must be present');
  if (dataWait) {
    assert.ok(result.heatmapData && result.heatmapData.status === 200 && result.heatmapData.strikeCount > 0 && result.heatmapData.matrixRows > 0 && result.heatmapData.finiteSpot,
      'A real, nonempty upstream heatmap response must reach the browser');
    assert.equal(result.emptyHeatmapMessage, false, 'Original heatmap must no longer show its empty-data message');
  }
} catch (error) {
  result.failure = sanitize(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL(`${variant}.json`, out), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
