// Only our IIFE runs in vm. Archived third-party JS is parsed with acorn, never executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { TARGETS, patchAsset, exportsIn, parseJS, sha256 } from './generate-auth-patches.mjs';

const adapterSource = await readFile(new URL('../frontend/gateway-auth-adapter.js', import.meta.url), 'utf8');
const START = 1800000000000;
const copy = value => JSON.parse(JSON.stringify(value));
// Synthetic, unsigned-by-design fixture; NEVER used outside VM unit tests.
function jwt(claims) { return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.dGVzdC1vbmx5`; }
function profile(now = START, overrides = {}) {
  const organization = { id: 'org_fixture', name: 'Real selected fixture organization', slug: 'fixture', imageUrl: null, publicMetadata: {} };
  const expiresAt = Math.floor(now / 1000) + 120;
  const claims = { sub: 'user_fixture', sid: 'sess_fixture', exp: expiresAt, iat: Math.floor(now / 1000), org_id: 'org_fixture', org_permissions: ['org:read'], custom: { unchanged: true } };
  return { source: 'upstream-verified', userSource: 'normal-clerk-session', profileComplete: true, fullWebsiteReady: false,
    user: { id: 'user_fixture', firstName: 'Fixture', lastName: null, fullName: 'Fixture User', username: null, imageUrl: null,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: null, primaryEmailAddressId: 'email_fixture',
      emailAddresses: [{ id: 'email_fixture', emailAddress: 'fixture@example.invalid' }], publicMetadata: { roles: ['fixture-role'] },
      organizationMemberships: [{ id: 'membership_fixture', role: 'org:member', organization }] },
    session: { id: 'sess_fixture', status: 'active', actor: null, expireAt: new Date(now + 3600000).toISOString(), lastActiveAt: new Date(now).toISOString() },
    organization, token: jwt(claims), expiresAt, ...overrides };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(handler = () => profile(), options = {}) {
  let now = START, sequence = 0, forbidden = 0;
  const timers = new Map(), requests = [], navigations = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const window = {
    atob: s => Buffer.from(s, 'base64').toString('binary'), AbortController,
    location: { assign: value => navigations.push(value) },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(path, options) {
      requests.push({ path, options });
      const value = await handler(path, options, requests.length, now);
      if (value && typeof value.ok === 'boolean') return value;
      return { ok: true, json: async () => copy(value) };
    },
  };
  // localStorage stays forbidden by default (tokens must never be stored). A test may
  // opt in to an in-memory store to verify only allowlisted UI metadata is written.
  const forbiddenKeys = options.storage ? ['sessionStorage', 'document', 'console'] : ['localStorage', 'sessionStorage', 'document', 'console'];
  if (options.storage) window.localStorage = options.storage;
  for (const key of forbiddenKeys) Object.defineProperty(window, key, { get() { forbidden++; throw new Error('forbidden side effect'); } });
  const react = {
    useSyncExternalStore(subscribe, snapshot) { const unsubscribe = subscribe(() => {}); unsubscribe(); return snapshot(); },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    isValidElement(element) { return !!element && element.type !== undefined; },
    cloneElement(element, props) { return { ...element, props: { ...element.props, ...props } }; },
  };
  const context = vm.createContext({ window, Date: ClockDate });
  new vm.Script(adapterSource, { filename: 'gateway-auth-adapter.js' }).runInContext(context, { timeout: 1000 });
  const root = window.__SKYLIT_GATEWAY_AUTH;
  const hooks = root.bindReact({ default: react });
  return { window, root, hooks, react, context, requests, navigations, timers,
    get forbidden() { return forbidden; }, get now() { return now; },
    async advance(ms) {
      now += ms;
      for (let turn = 0; turn < 100; turn++) {
        const due = [...timers].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) { await flush(); return; }
        timers.delete(due[0]); due[1].fn(); await flush();
      }
      throw new Error('timer loop');
    },
  };
}
function assertUnknown(h) {
  const auth = h.hooks.useAuth();
  assert.equal(auth.isLoaded, false); assert.equal(auth.isSignedIn, undefined); assert.equal(auth.userId, undefined);
  assert.equal(auth.has({ permission: 'org:read' }), false);
  assert.equal(h.hooks.SignedIn({ children: 'secret' }), null);
  assert.equal(h.hooks.SignedOut({ children: 'anonymous' }), null);
  assert.equal(h.hooks.ClerkLoaded({ children: 'loaded' }), null);
}

test('hydration preserves original server children without declaring unknown identity authenticated', () => {
  const blocked = deferred(), h = harness(() => blocked.promise);
  const hydrationReact = { ...h.react, useSyncExternalStore(_subscribe, _snapshot, serverSnapshot) { return serverSnapshot(); } };
  const hooks = h.root.bindReact(hydrationReact);
  const originalChildren = { type: 'original-server-subtree', props: {} };
  assert.equal(hooks.ClerkProvider({ children: originalChildren }), originalChildren);
  assert.equal(hooks.SignedIn({ children: 'private' }), null);
  assert.equal(hooks.useAuth().isSignedIn, undefined);
});

test('same page React, stable bindings, loading diagnostics and no unknown authentication', async () => {
  const blocked = deferred(), h = harness(() => blocked.promise);
  assert.equal(h.root.bindReact(h.react), h.hooks);
  assert.equal(h.root.bindReact({ default: h.react }).useAuth, h.hooks.useAuth);
  assert.throws(() => h.root.bindReact({}), /page-react-required/);
  assertUnknown(h);
  assert.equal(h.hooks.ClerkLoading({ children: 'loading' }), 'loading');
  assert.equal(h.hooks.ClerkProvider({ children: 'private' }).props['data-skylit-gateway-diagnostic'], 'bootstrap-pending');
  blocked.resolve(profile()); await flush();
  assert.equal(h.hooks.ClerkProvider({ children: 'original-children' }), 'original-children');
  assert.equal(h.hooks.SignedIn({ children: 'original' }), 'original');
  assert.equal(h.hooks.SignedOut({ children: 'out' }), null);
  assert.equal(h.hooks.ClerkLoaded({ children: 'loaded' }), 'loaded');
  assert.equal(h.hooks.ClerkLoading({ children: 'loading' }), null);
  new vm.Script(adapterSource).runInContext(h.context, { timeout: 1000 });
  assert.equal(h.window.__SKYLIT_GATEWAY_AUTH, h.root); assert.equal(h.requests.length, 1);
});

test('real selected profile and unchanged claims, explicit read-only resources, exact permissions only', async () => {
  const p = profile(), h = harness(() => p); await flush();
  const auth = h.hooks.useAuth(), user = h.hooks.useUser().user, session = h.hooks.useSession().session;
  assert.equal(auth.userId, p.user.id); assert.equal(auth.sessionId, p.session.id);
  assert.deepEqual(copy(auth.sessionClaims), JSON.parse(Buffer.from(p.token.split('.')[1], 'base64url')));
  assert.deepEqual(copy(user.publicMetadata), p.user.publicMetadata);
  assert.equal(user.primaryEmailAddress.emailAddress, p.user.emailAddresses[0].emailAddress);
  assert.equal(session.expireAt.toISOString(), p.session.expireAt); assert.equal(session.actor, null);
  assert.equal(auth.orgRole, 'org:member'); assert.equal(auth.orgId, p.organization.id);
  assert.equal(auth.has({ permission: 'org:read' }), true);
  for (const query of [{}, { permission: 'read' }, { permission: 'org:admin' }, { role: 'org:member' }, { plan: 'pro' }, { feature: 'all' }, { permission: 'org:read', plan: 'pro' }, null]) assert.equal(auth.has(query), false);
  assert.equal(auth.has(Object.assign(Object.create({ permission: 'org:read' }), { feature: 'unknown' })), false);
  assert.equal(h.hooks.useOrganization().organization.name, p.organization.name);
  assert.equal(h.hooks.useOrganization().membership.role, 'org:member');
  assert.equal(h.hooks.useOrganization({ memberships: true }).isLoaded, false);
  assert.equal(h.hooks.useOrganizationList().userMemberships.data.length, 1);
  assert.equal(h.hooks.useOrganizationList({ userInvitations: true }).isLoaded, false);
  assert.equal(h.hooks.useOrganizationList().userInvitations, undefined);
  await assert.rejects(user.update({ firstName: 'fake' }), /unsupported/);
  await assert.rejects(session.touch(), /unsupported/);
  await assert.rejects(h.hooks.useClerk().setActive({ organization: 'fake' }), /unsupported/);
  assert.equal(h.hooks.useSignIn().signIn, undefined); assert.equal(h.hooks.useSignUp().signUp, undefined);
  assert.throws(() => { user.publicMetadata.roles.push('admin'); });
  assert.equal(h.forbidden, 0);
});

test('null organization is genuinely null, not fabricated membership/role', async () => {
  const p = profile(); p.organization = null; p.user.organizationMemberships = [];
  const h = harness(() => p); await flush();
  assert.equal(h.hooks.useOrganization().organization, null);
  assert.equal(h.hooks.useAuth().orgRole, undefined); assert.equal(h.hooks.useAuth().has({ permission: 'org:read' }), false);
  assert.equal(h.hooks.useOrganizationList().userMemberships.count, 0);
});

const invalidProfiles = [
  p => { delete p.profileComplete; }, p => { p.profileComplete = false; }, p => { p.source = 'unverified'; },
  p => { p.userSource = 'gateway-generated'; }, p => { p.fullWebsiteReady = true; },
  p => { p.user = { id: p.user.id }; }, p => { delete p.user.publicMetadata; },
  p => { delete p.user.organizationMemberships; }, p => { delete p.user.emailAddresses; }, p => { delete p.user.fullName; },
  p => { p.user.primaryEmailAddressId = 'unknown'; }, p => { p.session.status = 'pending'; },
  p => { delete p.session.actor; }, p => { p.session.actor = 'fake'; }, p => { p.session.expireAt = null; },
  p => { p.session.expireAt = '2020-01-01T00:00:00Z'; }, p => { delete p.organization; },
  p => { p.organization.id = ''; }, p => { p.user.organizationMemberships[0].role = ''; },
  p => { p.token = 'not-a-jwt'; }, p => { p.token = jwt({ sub: 'other', exp: p.expiresAt }); },
  p => { p.token = jwt({ sub: p.user.id, sid: 'other', exp: p.expiresAt }); },
  p => { p.token = jwt({ sub: p.user.id, org_id: 'other', exp: p.expiresAt }); },
  p => { p.expiresAt--; }, p => { p.expiresAt = START / 1000 - 1; p.token = jwt({ sub: p.user.id, exp: p.expiresAt }); },
  p => { p.expiresAt = START / 1000 + 3600; p.token = jwt({ sub: p.user.id, exp: p.expiresAt }); },
];
test('incomplete/unverified profile and inconsistent or expired token fail closed (no signatures claimed)', async t => {
  for (const [index, mutate] of invalidProfiles.entries()) await t.test(`invalid contract ${index + 1}`, async () => {
    const p = profile(); mutate(p); const h = harness(() => p); await flush(); assertUnknown(h);
    const element = h.hooks.ClerkProvider({ children: 'private' });
    assert.equal(element.props.role, 'alert'); assert.ok(element.props['data-skylit-gateway-diagnostic']);
    assert.equal(h.forbidden, 0);
  });
});

test('getToken caches in memory, refresh/reload singleflight, rejects unsupported templates, no storage/log/URL', async () => {
  let latest = profile(), gate = null;
  const h = harness(() => gate ? gate.promise : latest); await flush();
  assert.equal(await h.hooks.useAuth().getToken(), latest.token); assert.equal(h.requests.length, 1);
  for (const options of [{ template: 'x' }, { template: undefined }, { audience: 'x' }, { skipCache: 'yes' }]) await assert.rejects(h.hooks.useAuth().getToken(options), /unsupported/);
  assert.equal(h.requests.length, 1);
  gate = deferred();
  const a = h.hooks.useAuth().getToken({ skipCache: true }), b = h.hooks.useAuth().getToken({ skipCache: true }), c = h.hooks.useUser().user.reload();
  await flush(); assert.equal(h.requests.length, 2);
  latest = profile(START + 1000); gate.resolve(latest); await flush();
  assert.equal(await a, latest.token); assert.equal(await b, latest.token); assert.equal((await c).id, latest.user.id);
  for (const { path, options } of h.requests) {
    assert.equal(path, '/_gateway/auth/bootstrap'); assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(Object.keys(options.headers).some(name => /authorization|cookie/i.test(name)), false);
  }
  assert.equal(h.forbidden, 0); assert.deepEqual(h.navigations, []);
  assert.equal(Object.keys(h.root).join(','), 'bindReact');
});

test('normal expiry refreshes automatically and expired identity cannot remain authenticated on a hung refresh', async () => {
  let gate;
  const h = harness((_path, _options, count, now) => count === 1 ? profile(now) : gate.promise);
  await flush(); gate = deferred();
  await h.advance(105000); assert.equal(h.requests.length, 2); assert.equal(h.hooks.useAuth().isSignedIn, true);
  await h.advance(15000); assertUnknown(h);
  assert.equal(h.hooks.ClerkProvider({ children: 'private' }).props.role, 'alert');
  gate.resolve(profile(h.now)); await flush();
  // A timed out fetch cannot resurrect the store, even if the underlying mock ignores abort.
  assertUnknown(h);
});

test('Talon disclaimer acknowledgement is stored per device; other profile writes stay refused', async () => {
  const data = new Map();
  const storage = { getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)) };
  const h = harness(() => profile(START + 3000), { storage });
  await flush();
  const user = h.hooks.useUser().user;
  // Owner's choice: every device starts as already acknowledged (no modal at all).
  assert.equal(user.unsafeMetadata.talonAckVersion, '2026-08-02.v1');
  // Even with no device storage the default holds (e.g. storage disabled).
  const noStore = harness(() => profile(START + 3000), { storage: { getItem() { throw new Error('denied'); }, setItem() {} } });
  await flush();
  assert.equal(noStore.hooks.useUser().user.unsafeMetadata.talonAckVersion, '2026-08-02.v1');
  // Exactly what the original recordTalonAcknowledgement sends (spreads old metadata in).
  await user.update({ unsafeMetadata: { ...user.unsafeMetadata, talonAckVersion: '2026-08-02.v1', talonAckAt: '2026-10-24T08:00:00.000Z', injected: 'x' } });
  const after = h.hooks.useUser().user;
  assert.equal(after.unsafeMetadata.talonAckVersion, '2026-08-02.v1');
  assert.equal(after.unsafeMetadata.injected, undefined); // non-allowlisted keys are dropped
  const saved = JSON.parse([...data.values()][0]);
  assert.deepEqual(Object.keys(saved).sort(), ['talonAckAt', 'talonAckVersion']);
  assert.doesNotMatch([...data.values()].join(''), /eyJ/); // the token is never stored
  // A fresh page on the same device reads the stored acknowledgement back.
  const again = harness(() => profile(START + 3000), { storage });
  await flush();
  assert.equal(again.hooks.useUser().user.unsafeMetadata.talonAckVersion, '2026-08-02.v1');
  // Real profile changes are still refused and nothing is sent to the gateway.
  const sent = h.requests.length;
  await assert.rejects(after.update({ firstName: 'Mallory' }), /unsupported/);
  await assert.rejects(after.update({ unsafeMetadata: { talonAckVersion: 'x'.repeat(65) } }), /unsupported metadata value/);
  assert.equal(h.requests.length, sent);
});

test('a transient bootstrap failure recovers automatically without being treated as signed in', async () => {
  let failures = 2;
  const h = harness(() => failures-- > 0 ? { ok: false, status: 503 } : profile(START + 3000));
  await flush();
  assert.equal(h.hooks.ClerkProvider({ children: 'x' }).props.role, 'alert');
  assertUnknown(h); // still not authenticated while failing
  await h.advance(1000); // first retry: fails again
  assert.equal(h.hooks.useAuth().isSignedIn, undefined);
  await h.advance(2000); // second retry: succeeds
  assert.equal(h.hooks.useAuth().isSignedIn, true);
  assert.equal(h.hooks.ClerkProvider({ children: 'original' }), 'original');
  assert.equal(h.requests.length, 3);
  assert.equal(h.forbidden, 0);
});

test('bootstrap and getToken request have a bounded timeout and diagnostic, network failures are sanitized', async () => {
  const h = harness(() => new Promise(() => {})); await flush();
  const token = h.hooks.useAuth().getToken();
  await h.advance(10000); await assert.rejects(token, /bootstrap unavailable/); assertUnknown(h);
  assert.equal(h.hooks.ClerkProvider({ children: 'private' }).props['data-skylit-gateway-diagnostic'], 'request-timeout');
  const failure = harness(() => { const error = new Error('secret remote text'); error.code = 'secret remote code'; throw error; }); await flush();
  // A thrown fetch is reported as a blocked network request; the remote text/code never leaks.
  const shown = failure.hooks.ClerkProvider({ children: 'private' });
  assert.equal(shown.props['data-skylit-gateway-diagnostic'], 'network-blocked');
  assert.doesNotMatch(JSON.stringify(shown), /secret remote/);
  // A non-OK gateway reply exposes only its HTTP status in the code.
  const rejected = harness(() => ({ ok: false, status: 503 })); await flush();
  assert.equal(rejected.hooks.ClerkProvider({ children: 'private' }).props['data-skylit-gateway-diagnostic'], 'gateway-request-failed-503');
});

test('local logout only posts Gateway logout; pending bootstrap cannot resurrect local state', async () => {
  let gate;
  const h = harness((path, _options, count) => path === '/_gateway/logout' ? null : count === 1 ? profile() : gate.promise);
  await flush(); gate = deferred();
  const refresh = h.hooks.useAuth().getToken({ skipCache: true }); await flush();
  const logout = h.hooks.useClerk().signOut(); await logout;
  assert.equal(h.hooks.useAuth().isSignedIn, false); assert.equal(h.hooks.useAuth().userId, null);
  assert.equal(h.hooks.SignedOut({ children: 'local signed out' }), 'local signed out');
  assert.equal(h.hooks.SignedIn({ children: 'private' }), null);
  assert.equal(await h.hooks.useAuth().getToken(), null);
  gate.resolve(profile()); await assert.rejects(refresh, /unavailable/); await flush();
  assert.equal(h.hooks.useAuth().isSignedIn, false);
  assert.equal(h.requests.filter(r => r.path === '/_gateway/logout').length, 1);
  assert.ok(h.requests.every(r => r.path.startsWith('/_gateway/')));
  assert.equal(h.navigations.length, 0); assert.equal(h.forbidden, 0);
});

test('logout failure is unknown/error, and buttons never open upstream or claim full SDK UI', async () => {
  const h = harness(path => path === '/_gateway/logout' ? { ok: false } : profile()); await flush();
  const button = h.hooks.UserButton(); assert.equal(button.props['data-skylit-gateway-user'], 'read-only');
  assert.equal(button.children[0], profile().user.fullName);
  h.hooks.SignInButton({}).props.onClick(); assert.deepEqual(h.navigations, ['/_gateway/login']);
  await assert.rejects(h.hooks.useAuth().signOut(), /local logout failed/); assertUnknown(h);
  assert.equal(h.hooks.ClerkProvider({ children: 'private' }).props['data-skylit-gateway-diagnostic'], 'local-logout-failed');
});

test('both Turbopack export encodings retain layout and getter shape; unexpected/missing/duplicate targets reject', () => {
  for (const [filename, modules] of Object.entries(TARGETS)) {
    const source = Object.entries(modules).map(([id, names]) => `e.s([${names.map((name, i) => `${JSON.stringify(name)},${i % 2 ? '()=>original' : '0,original'}`).join(',')},"untouched",()=>unchanged],${id});`).join('\n');
    const { output, edits } = patchAsset(source, filename);
    assert.equal(edits.length, Object.values(modules).flat().length); parseJS(output);
    // The replacement uses the adapter API name, which may differ from the export name
    // for provider aliases (e.g. ClientClerkProvider -> ClerkProvider).
    for (const edit of edits) {
      const api = { ClientClerkProvider: 'ClerkProvider' }[edit.name] ?? edit.name;
      assert.equal(edit.replacement, `${edit.kind === 'getter' ? '()=>': ''}window.__SKYLIT_GATEWAY_AUTH.bindReact(e.i(271645)).${api}`);
    }
    assert.equal(exportsIn(output).filter(entry => entry.name === 'untouched').every(entry => output.slice(entry.start, entry.end) === '()=>unchanged'), true);
    const [id, names] = Object.entries(modules)[0];
    assert.throws(() => patchAsset(`${source}\ne.s([${JSON.stringify(names[0])},0,x],${id});`, filename), /exactly one/);
    assert.throws(() => patchAsset(source.replace(JSON.stringify(names[0]), '"renamed"'), filename), /exactly one/);
  }
  assert.throws(() => patchAsset('(', '3saht1vl84b4q.js'));
  assert.throws(() => patchAsset('e.s([]);', 'unknown.js'), /Unsupported/);
});

// The original upstream chunks are third-party code and are NOT committed. When the
// local archive is absent (e.g. in CI), the byte-level replay is skipped; the patched
// files and the Rust hash guards are still checked by the test below.
const ARCHIVE = process.env.SKYLIT_ASSET_ARCHIVE
  ? new URL(`file:///${process.env.SKYLIT_ASSET_ARCHIVE.replace(/\\/g, '/').replace(/^\/+/, '')}/`)
  : new URL('../../api-recon/assets/', import.meta.url);
const manifestForArchive = JSON.parse(await readFile(new URL('../frontend/manifest.json', import.meta.url), 'utf8'));
const archiveAvailable = await readFile(new URL(manifestForArchive.assets[0].filename, ARCHIVE))
  .then(() => true, () => false);

test('committed patches agree with manifest SHA256 and Rust hash guards (no archive needed)', async () => {
  const manifest = JSON.parse(await readFile(new URL('../frontend/manifest.json', import.meta.url), 'utf8'));
  const rust = await readFile(new URL('../frontend/generated.rs', import.meta.url), 'utf8');
  assert.equal(manifest.assets.length, 2);
  for (const asset of manifest.assets) {
    const patched = await readFile(new URL(`../frontend/patches/${asset.filename}`, import.meta.url), 'utf8');
    assert.equal(sha256(patched), asset.patchedSha256);
    assert.ok(rust.includes(`("${asset.path}", "${asset.originalSha256}", include_bytes!("patches/${asset.filename}"))`));
  }
});

test('generated public patches match manifest SHA256 and only exact 16 bindings changed; Rust includes hash guards',
  { skip: archiveAvailable ? false : 'original upstream chunk archive not present (third-party code is not committed)' }, async () => {
  const manifest = JSON.parse(await readFile(new URL('../frontend/manifest.json', import.meta.url), 'utf8'));
  const rust = await readFile(new URL('../frontend/generated.rs', import.meta.url), 'utf8');
  assert.equal(manifest.fullWebsiteReady, false); assert.equal(manifest.assets.length, 2);
  let total = 0;
  const covered = new Set();
  for (const asset of manifest.assets) {
    const original = await readFile(new URL(asset.filename, ARCHIVE), 'utf8');
    const patched = await readFile(new URL(`../frontend/patches/${asset.filename}`, import.meta.url), 'utf8');
    const result = patchAsset(original, asset.filename); assert.equal(patched, result.output);
    assert.equal(sha256(original), asset.originalSha256); assert.equal(sha256(patched), asset.patchedSha256);
    assert.ok(rust.includes(`("${asset.path}", "${asset.originalSha256}", include_bytes!("patches/${asset.filename}"))`));
    assert.ok(rust.includes(`"${asset.filename}",`));
    // Reconstruct input from unchanged ranges + replaced bindings, proving no gates/claims/SDK implementation removed.
    let restored = '', oldPos = 0, newPos = 0;
    for (const edit of result.edits) {
      const unchanged = original.slice(oldPos, edit.start);
      assert.equal(patched.slice(newPos, newPos + unchanged.length), unchanged);
      restored += unchanged + edit.original;
      newPos += unchanged.length + edit.replacement.length; oldPos = edit.end;
    }
    restored += patched.slice(newPos); assert.equal(restored, original);
    assert.equal(exportsIn(original).length, exportsIn(patched).length); parseJS(patched);
    total += result.edits.length;
    result.edits.forEach(edit => covered.add(edit.name));
  }
  // Every auth binding the adapter owns must be replaced; the same name may be re-exported
  // by more than one layer, so the edit count is checked against the manifest instead.
  const expected = manifest.assets.reduce((sum, asset) => sum + asset.bindings.length, 0);
  assert.equal(total, expected);
  // All 16 Clerk bindings must be replaced; provider aliases may add extra entries.
  const needed = ['ClerkProvider', 'SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading', 'useAuth', 'useUser',
    'useSession', 'useClerk', 'useSignIn', 'useSignUp', 'UserButton', 'SignInButton', 'SignOutButton',
    'useOrganization', 'useOrganizationList'];
  assert.deepEqual(needed.filter(n => !covered.has(n)), [], 'every Clerk binding must be replaced');
});
