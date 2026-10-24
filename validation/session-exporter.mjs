// Intermediary-only helper: refresh a SHORT-LIVED token from the user's dedicated
// normal Clerk session. Never reads the everyday browser profile or exports cookies.
// The snapshot is a runtime secret, never a build input or a company-browser response.
import { chromium } from 'playwright-core';
import { mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { selectFreshSession } from './session-refresh-policy.mjs';

const local = fileURLToPath(new URL('../.local/', import.meta.url));
await mkdir(resolve(local, 'session'), { recursive: true });
const localReal = await realpath(local);
const dir = await realpath(resolve(local, 'session'));
assert.equal(dirname(dir), localReal, 'runtime secret directory must stay inside dedicated local directory');
const exportBrowserAuthProfile = process.env.EXPORT_BROWSER_AUTH_PROFILE === 'true';
if (process.env.EXPORT_BROWSER_AUTH_PROFILE !== undefined && !['true', 'false'].includes(process.env.EXPORT_BROWSER_AUTH_PROFILE)) {
  throw new Error('EXPORT_BROWSER_AUTH_PROFILE must be true or false');
}
const profileSnapshot = resolve(dir, 'browser-profile.json');
const snapshot = resolve(dir, 'snapshot.json');
assert.equal(dirname(snapshot), dir);
const statusPath = resolve(localReal, 'session-exporter-status.json');
const duration = Number(process.env.SESSION_HELPER_SECONDS || 1200);
assert.ok(Number.isInteger(duration) && duration >= 30 && duration <= 14400);
const started = Date.now();
let context;
let timer;
let stopping = false;
let updates = 0, forcedSdkRenewals = 0, consecutiveFailures = 0;
// ~10 retries with backoff capped at 30s spans several minutes before giving up.
const MAX_CONSECUTIVE_FAILURES = 10, RELOAD_AFTER_FAILURES = 3;
const minimumRemainingSeconds = Number(process.env.SESSION_MIN_REMAINING_SECONDS || 45);
assert.ok(Number.isInteger(minimumRemainingSeconds) && minimumRemainingSeconds >= 5 && minimumRemainingSeconds <= 120);
const metadata = async state => writeFile(statusPath, JSON.stringify({
  state, checkedAt: new Date().toISOString(), tokenSnapshotsWritten: updates,
  cookiesExported: false, credentialsLogged: false, forcedSdkRenewals, minimumRemainingSeconds,
}, null, 2));
async function writeSnapshot(value, destination = snapshot) {
  const temp = resolve(dir, `snapshot-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  // Verify both absolute rename targets before the atomic replacement.
  assert.equal(dirname(temp), dir);
  assert.equal(dirname(destination), dir);
  assert.ok(destination === snapshot || destination === profileSnapshot);
  const json = JSON.stringify(value);
  assert.ok(Buffer.byteLength(json) <= 64 * 1024, 'snapshot exceeds size bound');
  await writeFile(temp, json, { flag: 'wx', mode: 0o600 });
  await rename(temp, destination);
}
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  // Overwrite the snapshot with a deliberately unusable value on orderly shutdown.
  await writeSnapshot({ bearerToken: '', expiresAt: 0, capturedAt: 0 }).catch(() => {});
  if (exportBrowserAuthProfile) await writeSnapshot({ source: 'normal-clerk-session', capturedAt: 0 }, profileSnapshot).catch(() => {});
  await metadata(reason).catch(() => {});
  await context?.close().catch(() => {});
}
process.once('SIGINT', () => void stop('stopped'));
process.once('SIGTERM', () => void stop('stopped'));
try {
  context = await chromium.launchPersistentContext(resolve(localReal, 'upstream-profile'), {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://app.skylit.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.Clerk?.session?.status === 'active', undefined, { timeout: 30000 });
  async function refresh() {
    if (stopping) return;
    if (Date.now() - started >= duration * 1000) return stop('duration-limit');
    try {
      const readBrowserSession = async options => {
        const exportProfile = options.exportProfile;
        const clerk = window.Clerk;
        const session = clerk?.session;
        if (session?.status !== 'active') return null;
        // Only normal SDK getToken may make a network request. Resource projection
        // below is read-only: no reload(), membership fetch or cookie access.
        const token = await session.getToken(options.force ? { skipCache: true } : undefined);
        if (!exportProfile) return { token };
        const user = clerk.user;
        if (!user || clerk.session !== session) throw new Error('SDK resources unavailable');
        const nullable = value => value === undefined ? null : value;
        const date = value => {
          if (value === undefined || value === null) return null;
          if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Unsupported SDK date');
          return value.toISOString();
        };
        const organization = org => ({
          id: org.id, name: org.name, slug: nullable(org.slug), imageUrl: nullable(org.imageUrl),
          publicMetadata: org.publicMetadata,
        });
        let actor = nullable(session.actor);
        if (actor !== null && typeof actor === 'object' && !Array.isArray(actor)) {
          actor = Object.fromEntries(['sub', 'iss', 'sid'].filter(key => actor[key] !== undefined).map(key => [key, actor[key]]));
        } else if (actor !== null) {
          throw new Error('Unsupported SDK actor');
        }
        const profile = {
          source: 'normal-clerk-session', capturedAt: Math.floor(Date.now() / 1000),
          user: {
            id: user.id, firstName: nullable(user.firstName), lastName: nullable(user.lastName),
            fullName: nullable(user.fullName), username: nullable(user.username), imageUrl: nullable(user.imageUrl),
            createdAt: date(user.createdAt), updatedAt: date(user.updatedAt), publicMetadata: user.publicMetadata,
            // Missing resources stay missing, not fabricated as empty arrays.
            ...(Array.isArray(user.organizationMemberships) ? { organizationMemberships: user.organizationMemberships.map(membership => ({
              id: membership.id, role: membership.role, organization: organization(membership.organization),
            })) } : {}),
            primaryEmailAddressId: nullable(user.primaryEmailAddressId),
            ...(Array.isArray(user.emailAddresses) ? { emailAddresses: user.emailAddresses.map(email => ({ id: email.id, emailAddress: email.emailAddress })) } : {}),
          },
          session: { id: session.id, status: session.status, actor, expireAt: date(session.expireAt), lastActiveAt: date(session.lastActiveAt) },
          organization: clerk.organization === null ? null : organization(clerk.organization),
        };
        return { token, profile };
      };
      // A normal cached token can be too close to expiry for a slightly skewed
      // intermediary VM. Ask the real SDK for at most one fresh token in that case;
      // never modify exp/iat, lower the gateway's validation, or loop login retries.
      const selected = await selectFreshSession(force => page.evaluate(readBrowserSession,
        { exportProfile: exportBrowserAuthProfile, force }), undefined, minimumRemainingSeconds);
      const { result, token, expiresAt, capturedAt: now } = selected;
      if (selected.forcedRefresh) forcedSdkRenewals++;
      if (exportBrowserAuthProfile) await writeSnapshot(result.profile, profileSnapshot);
      await writeSnapshot({ bearerToken: token, expiresAt, capturedAt: now });
      updates++;
      await metadata('active');
      if (updates === 1) console.log('Dedicated intermediary session ready. Runtime snapshot is secret; no token/cookie logged.');
      // Bounded scheduling, not a retry loop; use the normal SDK cache when fresh.
      const delay = Math.max(5, Math.min(15, expiresAt - now - minimumRemainingSeconds + 1));
      timer = setTimeout(() => void refresh(), delay * 1000);
    } catch (_) {
      // One transient failure (network blip, SDK hiccup) must not end the helper:
      // that left every company device on "Gateway authentication unavailable".
      // Retry with bounded backoff. Only a sustained outage invalidates the snapshot
      // and stops; the existing snapshot keeps its own strict expiry meanwhile.
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('Session refresh unavailable; snapshot invalidated. Restore normal intermediary login if needed.');
        process.exitCode = 1;
        await stop('session-unavailable');
        return;
      }
      await metadata(`retrying-${consecutiveFailures}`).catch(() => {});
      if (consecutiveFailures === RELOAD_AFTER_FAILURES) {
        // A wedged SDK page recovers on a normal reload of the same signed-in profile.
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForFunction(() => window.Clerk?.session?.status === 'active', undefined, { timeout: 30000 }).catch(() => {});
      }
      timer = setTimeout(() => void refresh(), Math.min(30, 2 ** consecutiveFailures) * 1000);
      return;
    }
    consecutiveFailures = 0;
  }
  await refresh();
  if (!stopping) await new Promise(resolveDone => context.once('close', resolveDone));
} catch (_) {
  console.error('Dedicated session helper unavailable. No credentials logged.');
  process.exitCode = 1;
} finally {
  await stop(stopping ? 'stopped' : 'closed');
}
