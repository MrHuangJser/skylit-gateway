// Feasibility test: can a headless browser sign in to Skylit with the owner's
// email + password, or does Clerk demand a CAPTCHA / email code?
// Prints only booleans, statuses and short reason codes. No credentials, no tokens.
import { chromium } from 'playwright-core';
import { loadCredentials, safeTarget } from './account-credentials.mjs';

const headed = process.env.HEADED === 'true';
const credentials = await loadCredentials();
console.log('target:', safeTarget(credentials.loginUrl));

const browser = await chromium.launch({ headless: !headed,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-blink-features=AutomationControlled'] });
const result = { steps: [], outcome: 'unknown' };
const note = (step, detail = {}) => { result.steps.push({ step, ...detail }); console.log(step, JSON.stringify(detail)); };
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  const captchaHosts = new Set();
  page.on('request', r => {
    const host = new URL(r.url()).hostname;
    if (/turnstile|recaptcha|hcaptcha|challenges\.cloudflare/.test(host)) captchaHosts.add(host);
  });
  await page.goto(credentials.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  note('navigated', { url: new URL(page.url()).pathname });

  // Clerk renders either a combined form or separate steps. The configured URL may be
  // the app root, so fall back to the app's own sign-in routes and the accounts host.
  const emailSelector = 'input[name="identifier"], input[type="email"], input[name="emailAddress"]';
  const origin = new URL(credentials.loginUrl).origin;
  const candidates = [credentials.loginUrl, `${origin}/login`, `${origin}/sign-in`, 'https://accounts.skylit.ai/sign-in'];
  let email;
  for (const url of candidates) {
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    email = page.locator(emailSelector).first();
    const found = await email.waitFor({ timeout: 12000 }).then(() => true, () => false);
    note('login form', { url: new URL(page.url()).origin + new URL(page.url()).pathname, found });
    if (found) break;
  }
  if (!email || !(await email.count())) throw new Error('no sign-in form found on any known route');
  await email.fill(credentials.account);
  note('email filled');
  for (const label of [/^continue$/i, /^next$/i]) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.count() && await button.isVisible()) { await button.click(); break; }
  }
  const password = page.locator('input[type="password"]').first();
  const passwordVisible = await password.waitFor({ timeout: 25000 }).then(() => true, () => false);
  note('password field', { visible: passwordVisible });
  if (passwordVisible) {
    await password.fill(credentials.password);
    await page.getByRole('button', { name: /^continue$|^sign in$/i }).first().click();
  }
  // Success = an active Clerk session, not merely a URL change.
  const active = await page.waitForFunction(
    () => window.Clerk?.session?.status === 'active' || window.Clerk?.user?.id,
    undefined, { timeout: 45000 }).then(() => true, () => false);
  const after = new URL(page.url());
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
  const needsCode = /verification code|check your email|one-time code|enter the code/i.test(bodyText);
  const wrongPassword = /password is incorrect|incorrect password|doesn.t match/i.test(bodyText);
  result.captchaHosts = [...captchaHosts];
  result.sessionActive = active;
  result.needsEmailCode = needsCode;
  result.rejectedPassword = wrongPassword;
  result.finalPath = after.pathname;
  result.outcome = active ? 'login-ok' : needsCode ? 'needs-email-code' : wrongPassword ? 'bad-credentials'
    : captchaHosts.size ? 'captcha-required' : 'blocked-unknown';
  note('verdict', { outcome: result.outcome, sessionActive: active });
  if (active) {
    // Prove a usable token can be obtained from this session.
    const tokenOk = await page.evaluate(async () => {
      try { const t = await window.Clerk.session.getToken(); return typeof t === 'string' && t.split('.').length === 3; }
      catch { return false; }
    });
    result.tokenObtainable = tokenOk;
    note('token', { obtainable: tokenOk });
  }
  await context.storageState({ path: 'validation/results/password-login-state.json' }).catch(() => {});
} catch (error) {
  result.outcome = 'error';
  result.error = String(error?.message || error).slice(0, 300);
  note('error', { message: result.error });
} finally {
  await browser.close();
  console.log(JSON.stringify({ outcome: result.outcome, captcha: result.captchaHosts ?? [],
    sessionActive: result.sessionActive ?? false, needsEmailCode: result.needsEmailCode ?? false,
    tokenObtainable: result.tokenObtainable ?? false }, null, 2));
  if (result.outcome !== 'login-ok') process.exitCode = 1;
}
