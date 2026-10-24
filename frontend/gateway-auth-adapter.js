/* Local, read-only Gateway adapter. No vendor execution and no second React.
 * Trust comes from the same-origin upstream-verified bootstrap, NOT JWT decoding.
 * The JWT decoder below checks identity/expiry consistency; it does not verify signatures.
 */
(function (window) {
  'use strict';
  if (window.__SKYLIT_GATEWAY_AUTH) return;
  var TIMEOUT_MS = 10000, REFRESH_MARGIN_MS = 15000, MAX_TOKEN_SECONDS = 900;
  var listeners = new Set(), bindings = new WeakMap(), localFailures = new WeakSet();
  var state = Object.freeze({ status: 'loading', code: 'bootstrap-pending' });
  var pending = null, generation = 0, refreshTimer = null, expiryTimer = null;
  var token = null, tokenExpiry = 0, logoutPending = null;
  // A transient bootstrap failure (e.g. intermediary token rotation) must not leave
  // the page stuck. Retry with bounded backoff; the state stays 'error' meanwhile,
  // so nothing is treated as authenticated until a real verified bootstrap succeeds.
  var RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000], retryTimer = null, retryIndex = 0;
  function scheduleRetry() {
    if (retryTimer !== null || logoutPending || state.status === 'anonymous') return;
    var delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex++;
    retryTimer = window.setTimeout(function () { retryTimer = null; bootstrap().catch(function () {}); }, delay);
  }
  function record(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(v, key) { return Object.prototype.hasOwnProperty.call(v, key); }
  function nonempty(v) { return typeof v === 'string' && v.trim().length > 0; }
  function fail(code) { var e = new Error('Gateway auth: ' + code); e.code = code; localFailures.add(e); throw e; }
  function freeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.keys(v).forEach(function (key) { freeze(v[key]); }); Object.freeze(v);
    }
    return v;
  }
  // Device-local UI acknowledgements (e.g. the Talon disclaimer). The original client
  // records them in Clerk user.unsafeMetadata, which the read-only adapter cannot
  // write. They are kept per device in localStorage and exposed as unsafeMetadata, so
  // the modal is shown and accepted once per device. Only an explicit allowlist of
  // UI keys is stored; nothing here grants access or is sent to the upstream.
  var UI_METADATA_KEY = 'skylit-gateway:ui-metadata:v1';
  var UI_METADATA_FIELDS = ['talonAckVersion', 'talonAckAt'];
  // Owner's explicit choice: every company device is treated as having accepted the
  // Talon disclaimer, so the modal never appears. The value must equal the original
  // client's TALON_AGREEMENT_VERSION (read from the live bundle); if Skylit bumps that
  // version the modal reappears until this constant is updated.
  var TALON_ACK_DEFAULTS = { talonAckVersion: '2026-08-02.v1', talonAckAt: '2026-10-24T00:00:00.000Z' };
  function readUiMetadata() {
    var out = { talonAckVersion: TALON_ACK_DEFAULTS.talonAckVersion, talonAckAt: TALON_ACK_DEFAULTS.talonAckAt };
    try {
      var raw = JSON.parse(window.localStorage.getItem(UI_METADATA_KEY) || '{}');
      if (record(raw)) UI_METADATA_FIELDS.forEach(function (k) { if (typeof raw[k] === 'string' && raw[k].length <= 64) out[k] = raw[k]; });
      return out;
    } catch (_) { return out; }
  }
  function writeUiMetadata(next) {
    if (!record(next)) return Promise.reject(new Error('Gateway adapter: invalid metadata'));
    var out = readUiMetadata();
    UI_METADATA_FIELDS.forEach(function (k) {
      if (own(next, k)) {
        if (typeof next[k] !== 'string' || next[k].length > 64) throw new Error('Gateway adapter: unsupported metadata value');
        out[k] = next[k];
      }
    });
    try { window.localStorage.setItem(UI_METADATA_KEY, JSON.stringify(out)); }
    catch (_) { return Promise.reject(new Error('Gateway adapter: device storage unavailable')); }
    return out;
  }
  function clearTimers() { window.clearTimeout(refreshTimer); window.clearTimeout(expiryTimer); }
  function cancelRetry() { if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null; } }
  function emit(next) { state = freeze(next); listeners.forEach(function (fn) { fn(); }); }
  function clear(next) { clearTimers(); token = null; tokenExpiry = 0; emit(next); }
  function unsupported() { return Promise.reject(new Error('Gateway read-only adapter: operation unsupported')); }
  function dateValue(v) {
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) fail('profile-date-invalid');
    return new Date(v);
  }
  function nullableFields(v, fields) {
    fields.forEach(function (key) { if (!own(v, key) || !(v[key] === null || typeof v[key] === 'string')) fail('profile-field-missing'); });
  }
  function organization(v) {
    if (!record(v) || !nonempty(v.id) || !nonempty(v.name) || !record(v.publicMetadata)) fail('organization-invalid');
    nullableFields(v, ['slug', 'imageUrl']);
    var out = { id: v.id, name: v.name, slug: v.slug, imageUrl: v.imageUrl, publicMetadata: v.publicMetadata, __gatewayReadOnly: true };
    ['update', 'destroy', 'getMemberships', 'getInvitations', 'inviteMember', 'addMember', 'removeMember', 'updateMember'].forEach(function (key) { out[key] = unsupported; });
    return out;
  }
  function decodeJWT(raw) {
    if (typeof raw !== 'string' || raw.length > 65536) fail('token-invalid');
    var parts = raw.split('.');
    if (parts.length !== 3 || parts.some(function (p) { return !/^[A-Za-z0-9_-]+$/.test(p); })) fail('token-invalid');
    try {
      var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var bytes = window.atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
      var escaped = Array.prototype.map.call(bytes, function (c) { return '%' + c.charCodeAt(0).toString(16).padStart(2, '0'); }).join('');
      var claims = JSON.parse(decodeURIComponent(escaped));
      if (!record(claims)) fail('token-invalid');
      return claims;
    } catch (_) { fail('token-invalid'); }
  }
  function validate(v) {
    if (!record(v) || v.source !== 'upstream-verified' || v.userSource !== 'normal-clerk-session' || v.profileComplete !== true || v.fullWebsiteReady !== false) fail('verified-profile-required');
    var u = v.user, s = v.session;
    if (!record(u) || !nonempty(u.id) || !record(u.publicMetadata) || !Array.isArray(u.organizationMemberships) || !Array.isArray(u.emailAddresses)) fail('profile-incomplete');
    nullableFields(u, ['firstName', 'lastName', 'fullName', 'username', 'imageUrl', 'createdAt', 'updatedAt', 'primaryEmailAddressId']);
    if (!record(s) || !nonempty(s.id) || s.status !== 'active' || !own(s, 'actor') || !(s.actor === null || record(s.actor))) fail('session-incomplete');
    var sessionExpiry = dateValue(s.expireAt), lastActiveAt = dateValue(s.lastActiveAt);
    if (sessionExpiry.getTime() <= Date.now()) fail('session-expired');
    if (!own(v, 'organization')) fail('organization-unknown');
    var org = v.organization === null ? null : organization(v.organization);
    var memberships = u.organizationMemberships.map(function (m) {
      if (!record(m) || !nonempty(m.id) || !nonempty(m.role)) fail('membership-invalid');
      return { id: m.id, role: m.role, organization: organization(m.organization), __gatewayReadOnly: true, update: unsupported, destroy: unsupported };
    });
    var emails = u.emailAddresses.map(function (email) {
      if (!record(email) || !nonempty(email.id) || !nonempty(email.emailAddress)) fail('email-invalid');
      return { id: email.id, emailAddress: email.emailAddress, __gatewayReadOnly: true, destroy: unsupported };
    });
    if (u.primaryEmailAddressId !== null && !emails.some(function (email) { return email.id === u.primaryEmailAddressId; })) fail('primary-email-mismatch');
    var claims = decodeJWT(v.token), now = Date.now() / 1000;
    if (claims.sub !== u.id || !Number.isInteger(claims.exp) || claims.exp !== v.expiresAt || claims.exp <= now || claims.exp - now > MAX_TOKEN_SECONDS) fail('token-identity-expiry-mismatch');
    // sid is checked when present; no claims are manufactured, removed or rewritten.
    if (own(claims, 'sid') && claims.sid !== s.id) fail('token-session-mismatch');
    if (org && own(claims, 'org_id') && claims.org_id !== org.id) fail('token-organization-mismatch');
    var user = { id: u.id, firstName: u.firstName, lastName: u.lastName, fullName: u.fullName, username: u.username,
      imageUrl: u.imageUrl, createdAt: u.createdAt === null ? null : dateValue(u.createdAt), updatedAt: u.updatedAt === null ? null : dateValue(u.updatedAt),
      primaryEmailAddressId: u.primaryEmailAddressId, primaryEmailAddress: emails.find(function (email) { return email.id === u.primaryEmailAddressId; }) || null,
      emailAddresses: emails, publicMetadata: u.publicMetadata, organizationMemberships: memberships, __gatewayReadOnly: true,
      reload: function () { return bootstrap().then(function () { return state.user; }); } };
    // Lazy: device storage is read only when the original code actually asks for it.
    // Non-enumerable so deep-freeze and spreads never read storage; direct access works.
    Object.defineProperty(user, 'unsafeMetadata', { enumerable: false, configurable: false, get: function () { return readUiMetadata(); } });
    ['delete', 'setProfileImage', 'createEmailAddress', 'createPhoneNumber', 'createExternalAccount', 'updatePassword', 'createOrganization', 'getOrganizationMemberships'].forEach(function (key) { user[key] = unsupported; });
    // update() accepts ONLY allowlisted UI keys in unsafeMetadata and stores them on
    // this device; any other profile change is still unsupported.
    user.update = function (params) {
      if (!record(params) || !record(params.unsafeMetadata) || Object.keys(params).some(function (k) { return k !== 'unsafeMetadata'; })) return unsupported();
      var stored;
      try {
        // Unknown keys the original code carried over from the old metadata are ignored, not stored.
        var picked = {};
        UI_METADATA_FIELDS.forEach(function (k) { if (own(params.unsafeMetadata, k)) picked[k] = params.unsafeMetadata[k]; });
        stored = writeUiMetadata(picked);
      } catch (e) { return Promise.reject(e); }
      if (stored && typeof stored.then === 'function') return stored;
      // Re-emit a NEW user object so hooks re-render (the modal closes). Its getter
      // reads the freshly stored metadata.
      if (state.status === 'ready') {
        var nextUser = Object.create(Object.getPrototypeOf(state.user), Object.getOwnPropertyDescriptors(state.user));
        var nextSession = Object.assign({}, state.session, { user: nextUser });
        emit(Object.assign({}, state, { user: nextUser, session: nextSession }));
      }
      return Promise.resolve(state.user);
    };
    var session = { id: s.id, status: s.status, actor: s.actor, expireAt: sessionExpiry, lastActiveAt: lastActiveAt, user: user,
      __gatewayReadOnly: true, getToken: getToken, reload: function () { return bootstrap().then(function () { return state.session; }); },
      end: signOut, remove: unsupported, touch: unsupported };
    return { status: 'ready', user: user, session: session, organization: org, claims: claims, expiresAt: v.expiresAt };
  }
  function post(path) {
    var controller = new window.AbortController(), timer;
    var timeout = new Promise(function (_, reject) {
      timer = window.setTimeout(function () { controller.abort(); var e = new Error('Gateway request timeout'); e.code = 'request-timeout'; localFailures.add(e); reject(e); }, TIMEOUT_MS);
    });
    return Promise.race([Promise.resolve().then(function () {
      return window.fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: '{}', signal: controller.signal })
        // A blocked/failed network request (e.g. a browser extension) gets its own code.
        .catch(function (error) { if (localFailures.has(error)) throw error; fail('network-blocked'); });
    }).then(function (response) {
      // Status code only (never the body): it tells which gateway check failed.
      if (!response.ok) fail('gateway-request-failed-' + response.status);
      if (path === '/_gateway/logout') return null;
      return response.json();
    }), timeout]).finally(function () { window.clearTimeout(timer); });
  }
  function bootstrap() {
    if (logoutPending) return Promise.reject(new Error('Gateway logout in progress'));
    if (pending) return pending;
    var current = generation;
    var request = post('/_gateway/auth/bootstrap').then(function (payload) {
      if (current !== generation) fail('request-superseded');
      var next = validate(payload);
      token = payload.token; tokenExpiry = next.expiresAt * 1000; clearTimers(); cancelRetry(); retryIndex = 0; emit(next);
      var remaining = tokenExpiry - Date.now();
      refreshTimer = window.setTimeout(function () { bootstrap().catch(function () {}); }, Math.max(1, remaining - Math.min(REFRESH_MARGIN_MS, remaining / 4)));
      expiryTimer = window.setTimeout(function () {
        if (Date.now() >= tokenExpiry) { clear({ status: 'error', code: 'token-expired' }); scheduleRetry(); }
      }, remaining);
      return next;
    }).catch(function (error) {
      if (current === generation) {
        clear({ status: 'error', code: localFailures.has(error) ? error.code : 'bootstrap-failed' });
        scheduleRetry();
      }
      // Never propagate remote error text, response bodies or credentials.
      throw new Error('Gateway auth bootstrap unavailable');
    }).finally(function () { if (pending === request) pending = null; });
    pending = request; return request;
  }
  function getToken(options) {
    options = options || {};
    if (!record(options) || Object.keys(options).some(function (key) { return key !== 'skipCache'; }) || (own(options, 'skipCache') && typeof options.skipCache !== 'boolean')) {
      return Promise.reject(new Error('Gateway token options/template unsupported'));
    }
    if (state.status === 'anonymous' || logoutPending) return Promise.resolve(null);
    if (!options.skipCache && token && tokenExpiry - Date.now() > REFRESH_MARGIN_MS) return Promise.resolve(token);
    return bootstrap().then(function () { if (!token || tokenExpiry <= Date.now()) fail('token-expired'); return token; });
  }
  function signOut() {
    if (logoutPending) return logoutPending;
    generation++; pending = null; cancelRetry(); clear({ status: 'loading', code: 'local-logout-pending' });
    logoutPending = post('/_gateway/logout').then(function () { clear({ status: 'anonymous', code: 'local-signed-out' }); }).catch(function () {
      clear({ status: 'error', code: 'local-logout-failed' }); throw new Error('Gateway local logout failed');
    }).finally(function () { logoutPending = null; });
    return logoutPending;
  }
  function has(query) {
    if (state.status !== 'ready' || !record(query) || Object.keys(query).length !== 1 || Object.keys(query)[0] !== 'permission' || !nonempty(query.permission)) return false;
    // Only explicit, exact org_permissions tied to the real selected organization.
    return !!state.organization && state.claims.org_id === state.organization.id && Array.isArray(state.claims.org_permissions) && state.claims.org_permissions.includes(query.permission);
  }
  function localEntry() { window.location.assign('/_gateway/login'); }
  function bindReact(moduleNamespace) {
    var React = moduleNamespace.default ?? moduleNamespace;
    if (!React || typeof React.useSyncExternalStore !== 'function' || typeof React.createElement !== 'function') fail('page-react-required');
    if (bindings.has(React)) return bindings.get(React);
    function useState() { return React.useSyncExternalStore(function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }, function () { return state; }, function () { return serverState; }); }
    function diagnostic(s) { return React.createElement('div', { role: s.status === 'error' ? 'alert' : 'status', 'data-skylit-gateway-diagnostic': s.code || s.status }, s.status === 'error' ? 'Gateway authentication unavailable (' + (s.code || 'unknown') + '). Retrying automatically; open /_gateway/diagnose for details.' : 'Gateway authentication loading. Original website not verified.'); }
    function useAuth() {
      var s = useState(), ready = s.status === 'ready', anonymous = s.status === 'anonymous';
      var membership = ready && s.organization ? s.user.organizationMemberships.find(function (m) { return m.organization.id === s.organization.id; }) : undefined;
      return { isLoaded: ready || anonymous, isSignedIn: ready ? true : anonymous ? false : undefined,
        userId: ready ? s.user.id : anonymous ? null : undefined, sessionId: ready ? s.session.id : anonymous ? null : undefined,
        sessionClaims: ready ? s.claims : undefined, actor: ready ? s.session.actor : undefined,
        orgId: ready ? s.organization && s.organization.id : undefined, orgSlug: ready ? s.organization && s.organization.slug : undefined,
        orgRole: membership && membership.role, orgPermissions: ready && s.organization && s.claims.org_id === s.organization.id && Array.isArray(s.claims.org_permissions) ? s.claims.org_permissions : undefined,
        getToken: getToken, signOut: signOut, has: has };
    }
    function useUser() { var s = useState(); return { isLoaded: s.status === 'ready' || s.status === 'anonymous', isSignedIn: s.status === 'ready' ? true : s.status === 'anonymous' ? false : undefined, user: s.status === 'ready' ? s.user : s.status === 'anonymous' ? null : undefined }; }
    function useSession() { var s = useState(); return { isLoaded: s.status === 'ready' || s.status === 'anonymous', isSignedIn: s.status === 'ready' ? true : s.status === 'anonymous' ? false : undefined, session: s.status === 'ready' ? s.session : s.status === 'anonymous' ? null : undefined }; }
    function useClerk() {
      var s = useState();
      return freeze({ __gatewayReadOnly: true, loaded: s.status === 'ready' || s.status === 'anonymous', isSignedIn: s.status === 'ready' ? true : s.status === 'anonymous' ? false : undefined,
        user: s.status === 'anonymous' ? null : s.user, session: s.status === 'anonymous' ? null : s.session, organization: s.status === 'anonymous' ? null : s.organization, signOut: signOut, openSignIn: localEntry, redirectToSignIn: localEntry,
        openSignUp: unsupported, redirectToSignUp: unsupported, openUserProfile: unsupported, openOrganizationProfile: unsupported,
        openCreateOrganization: unsupported, setActive: unsupported, createOrganization: unsupported, updateUser: unsupported });
    }
    function useOrganization(options) {
      var s = useState(), ready = s.status === 'ready', org = ready ? s.organization : undefined;
      var membership = ready && org ? s.user.organizationMemberships.find(function (m) { return m.organization.id === org.id; }) : undefined;
      return { isLoaded: ready && !options, organization: org, membership: membership, __gatewayReadOnly: true,
        memberships: undefined, invitations: undefined, domains: undefined, membershipRequests: undefined };
    }
    function useOrganizationList(options) {
      var s = useState(), ready = s.status === 'ready';
      return { isLoaded: ready && !options, setActive: unsupported, __gatewayReadOnly: true,
        userMemberships: ready ? { data: s.user.organizationMemberships, count: s.user.organizationMemberships.length, isLoading: false, isFetching: false, hasNextPage: false, hasPreviousPage: false, fetchNext: unsupported, fetchPrevious: unsupported, revalidate: function () { return bootstrap(); } } : undefined,
        userInvitations: undefined, userSuggestions: undefined };
    }
    function gate(kind, props) {
      var s = useState();
      return ((kind === 'in' || kind === 'loaded') && s.status === 'ready') || (kind === 'out' && s.status === 'anonymous') || (kind === 'loaded' && s.status === 'anonymous') || (kind === 'loading' && s.status === 'loading') ? props.children : null;
    }
    function button(props, action, fallback) {
      var child = props && props.children;
      if (React.isValidElement && React.isValidElement(child) && React.cloneElement) return React.cloneElement(child, { onClick: action });
      return React.createElement('button', { type: 'button', onClick: action }, child || fallback);
    }
    function localLogout() { signOut().catch(function () {}); }
    var api = {
      useAuth: useAuth, useUser: useUser, useSession: useSession, useClerk: useClerk,
      useOrganization: useOrganization, useOrganizationList: useOrganizationList,
      useSignIn: function () { var s = useState(); return { isLoaded: s.status === 'ready' || s.status === 'anonymous', signIn: undefined, setActive: unsupported, __gatewayReadOnly: true }; },
      useSignUp: function () { var s = useState(); return { isLoaded: s.status === 'ready' || s.status === 'anonymous', signUp: undefined, setActive: unsupported, __gatewayReadOnly: true }; },
      // Hydration must preserve the original server subtree. Its own auth gates
      // still see unknown identity; diagnostics belong to subsequent client renders.
      ClerkProvider: function (props) { var s = useState(); return s === serverState || s.status === 'ready' || s.status === 'anonymous' ? props.children : diagnostic(s); },
      SignedIn: function (props) { return gate('in', props); }, SignedOut: function (props) { return gate('out', props); },
      ClerkLoaded: function (props) { return gate('loaded', props); }, ClerkLoading: function (props) { return gate('loading', props); },
      SignInButton: function (props) { useState(); return button(props, localEntry, 'Gateway sign in'); },
      SignOutButton: function (props) { useState(); return button(props, localLogout, 'Gateway sign out'); },
      UserButton: function () { var s = useState(); return s.status === 'ready' ? React.createElement('span', { 'data-skylit-gateway-user': 'read-only' }, s.user.fullName || s.user.username || s.user.primaryEmailAddress && s.user.primaryEmailAddress.emailAddress || s.user.id, ' ', button({}, localLogout, 'Gateway sign out')) : diagnostic(s); }
    };
    freeze(api); bindings.set(React, api); return api;
  }
  var serverState = Object.freeze({ status: 'loading', code: 'server-profile-unknown' });
  Object.defineProperty(window, '__SKYLIT_GATEWAY_AUTH', { value: Object.freeze({ bindReact: bindReact }), writable: false, configurable: false });
  bootstrap().catch(function () {});
})(window);
