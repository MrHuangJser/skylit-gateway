// VPS-side session helper: signs in to Skylit with the owner's email + password,
// keeps the normal Clerk session in a persistent browser profile, and exports a
// SHORT-LIVED token snapshot for the gateway. No cookies or credentials are logged
// or handed to the company browser; the snapshot directory is a runtime secret.
import { chromium } from 'playwright-core';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { selectFreshSession } from './session-refresh-policy.mjs';

const APP = 'https://app.skylit.ai';
const outDir = resolve(process.env.SESSION_OUT_DIR || '/session');
const stateDir = resolve(process.env.BROWSER_STATE_DIR || '/state');
const account = process.env.SKYLIT_ACCOUNT || '';
const password = process.env.SKYLIT_PASSWORD || '';
const headless = process.env.HEADLESS !== 'false';
const minimumRemainingSeconds = Number(process.env.SESSION_MIN_REMAINING_SECONDS || 45);
const retryLimit = Number(process.env.SESSION_MAX_FAILURES || 12);

assert.ok(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(account), 'SKYLIT_ACCOUNT must be an email address');
assert.ok(password.length >= 8, 'SKYLIT_PASSWORD is missing or too short');
assert.ok(Number.isInteger(minimumRemainingSeconds) && minimumRemainingSeconds >= 5 && minimumRemainingSeconds <= 120);

await mkdir(outDir, { recursive: true });
await mkdir(stateDir, { recursive: true });
const snapshotPath = resolve(outDir, 'snapshot.json');
const profilePath = resolve(outDir, 'browser-profile.json');
const statusPath = resolve(outDir, 'sidecar-status.json');
for (const p of [snapshotPath, profilePath]) assert.equal(dirname(p), outDir);

let updates = 0, signIns = 0, failures = 0, stopping = false, timer = null, context = null;

async function writeAtomic(value, destination) {
  const temp = resolve(outDir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  assert.equal(dirname(temp), outDir);
  const json = JSON.stringify(value);
  assert.ok(Buffer.byteLength(json) <= 64 * 1024, 'snapshot exceeds size bound');
  await writeFile(temp, json, { flag: 'wx', mode: 0o600 });
  await rename(temp, destination);
}
const status = (state, extra = {}) => writeAtomic({
  state, checkedAt: new Date().toISOString(), tokenSnapshotsWritten: updates, signIns,
  credentialsLogged: false, cookiesExported: false, ...extra,
}, statusPath).catch(() => {});

// Exactly the projection the desktop helper uses; the Rust profile loader validates it.
async function readBrowserSession(options) {
  const clerk = window.Clerk;
  const session = clerk?.session;
  if (session?.status !== 'active') return null;
  const token = await session.getToken(options.force ? { skipCache: true } : undefined);
  if (!options.exportProfile) return { token };
  const user = clerk.user;
  if (!user || clerk.session !== session) throw new Error('SDK resources unavailable');
  const nullable = v => v === undefined ? null : v;
  const date = v => {
    if (v === undefined || v === null) return null;
    if (!(v instanceof Date) || !Number.isFinite(v.getTime())) throw new Error('Unsupported SDK date');
    return v.toISOString();
  };
  const organization = org => ({
    id: org.id, name: org.name, slug: nullable(org.slug), imageUrl: nullable(org.imageUrl), publicMetadata: org.publicMetadata });
  let actor = nullable(session.actor);
  if (actor !== null && typeof actor === 'object' && !Array.isArray(actor)) {
    actor = Object.fromEntries(['sub', 'iss', 'sid'].filter(k => actor[k] !== undefined).map(k => [k, actor[k]]));
  } else if (actor !== null) throw new Error('Unsupported SDK actor');
  return { token, profile: {
    source: 'normal-clerk-session', capturedAt: Math.floor(Date.now() / 1000),
    user: {
      id: user.id, firstName: nullable(user.firstName), lastName: nullable(user.lastName),
      fullName: nullable(user.fullName), username: nullable(user.username), imageUrl: nullable(user.imageUrl),
      createdAt: date(user.createdAt), updatedAt: date(user.updatedAt), publicMetadata: user.publicMetadata,
      ...(Array.isArray(user.organizationMemberships) ? { organizationMemberships: user.organizationMemberships.map(m => ({
        id: m.id, role: m.role, organization: organization(m.organization) })) } : {}),
      primaryEmailAddressId: nullable(user.primaryEmailAddressId),
      ...(Array.isArray(user.emailAddresses) ? { emailAddresses: user.emailAddresses.map(e => ({ id: e.id, emailAddress: e.emailAddress })) } : {}),
    },
    session: { id: session.id, status: session.status, actor, expireAt: date(session.expireAt), lastActiveAt: date(session.lastActiveAt) },
    organization: clerk.organization === null ? null : organization(clerk.organization),
  } };
}

const clerkState = page => page.evaluate(
  () => ({ status: window.Clerk?.session?.status ?? null, signedIn: Boolean(window.Clerk?.user?.id) }))
  .catch(() => ({ status: null, signedIn: false }));

/// Sign in through the normal web form. Clerk may render the field after a redirect,
/// so try each known entry point and stop at the first that shows an email input.
async function signIn(page) {
  const emailSelector = 'input[name="identifier"], input[type="email"], input[name="emailAddress"]';
  for (const url of [`${APP}/sign-in`, `${APP}/login`, 'https://accounts.skylit.ai/sign-in']) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const email = page.locator(emailSelector).first();
    if (!await email.waitFor({ timeout: 12000 }).then(() => true, () => false)) continue;
    await email.fill(account);
    for (const label of [/^continue$/i, /^next$/i]) {
      const button = page.getByRole('button', { name: label }).first();
      if (await button.count() && await button.isVisible()) { await button.click(); break; }
    }
    const field = page.locator('input[type="password"]').first();
    if (!await field.waitFor({ timeout: 25000 }).then(() => true, () => false)) {
      throw new Error('password step did not appear (an emailed code may be required)');
    }
    await field.fill(password);
    await page.getByRole('button', { name: /^continue$|^sign in$/i }).first().click();
    const ok = await page.waitForFunction(() => window.Clerk?.session?.status === 'active', undefined,
      { timeout: 60000 }).then(() => true, () => false);
    if (!ok) throw new Error('sign-in did not reach an active session');
    signIns++;
    console.log(`Signed in with the web form (attempt ${signIns}); credentials are never logged.`);
    return;
  }
  throw new Error('no sign-in form found');
}

async function ensureSession(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => Boolean(window.Clerk), undefined, { timeout: 45000 }).catch(() => {});
  if ((await clerkState(page)).status === 'active') return;
  console.log('No active session in the persistent profile; signing in.');
  await signIn(page);
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => window.Clerk?.session?.status === 'active', undefined, { timeout: 45000 });
}

async function refresh(page) {
  if (stopping) return;
  try {
    const selected = await selectFreshSession(
      force => page.evaluate(readBrowserSession, { exportProfile: true, force }),
      undefined, minimumRemainingSeconds);
    const { result, token, expiresAt, capturedAt } = selected;
    if (result.profile) await writeAtomic(result.profile, profilePath);
    await writeAtomic({ bearerToken: token, expiresAt, capturedAt }, snapshotPath);
    updates++;
    failures = 0;
    await status('active', { expiresAt });
    if (updates === 1) console.log('Gateway session snapshot ready (secret; never logged).');
    const delay = Math.max(5, Math.min(15, expiresAt - capturedAt - minimumRemainingSeconds + 1));
    timer = setTimeout(() => void refresh(page), delay * 1000);
  } catch (error) {
    failures++;
    console.error(`refresh failed (${failures}/${retryLimit}): ${String(error?.message || error).slice(0, 160)}`);
    if (failures >= retryLimit) {
      await writeAtomic({ bearerToken: '', expiresAt: 0, capturedAt: 0 }, snapshotPath).catch(() => {});
      await status('session-unavailable', { failures });
      process.exitCode = 1;
      await stop('session-unavailable');
      return;
    }
    await status(`retrying-${failures}`, { failures });
    if ((await clerkState(page)).status !== 'active') await ensureSession(page).catch(() => {});
    timer = setTimeout(() => void refresh(page), Math.min(30, 2 ** failures) * 1000);
  }
}

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await writeAtomic({ bearerToken: '', expiresAt: 0, capturedAt: 0 }, snapshotPath).catch(() => {});
  await status(reason).catch(() => {});
  await context?.close().catch(() => {});
}
process.once('SIGTERM', () => void stop('stopped'));
process.once('SIGINT', () => void stop('stopped'));

try {
  await status('starting');
  context = await chromium.launchPersistentContext(resolve(stateDir, 'profile'), {
    headless, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    viewport: { width: 1280, height: 900 }, locale: 'en-US',
  });
  const page = context.pages()[0] || await context.newPage();
  await ensureSession(page);
  await refresh(page);
  if (!stopping) await new Promise(done => context.once('close', done));
} catch (error) {
  console.error('session sidecar unavailable:', String(error?.message || error).slice(0, 200));
  await status('failed');
  process.exitCode = 1;
} finally {
  await stop(stopping ? 'stopped' : 'closed');
}
