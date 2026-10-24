// Offline acceptance of the specific original-homepage black-screen repair.
// This does NOT assert that every Skylit page, write action or realtime protocol works.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const dir = new URL('./results/black-screen/', import.meta.url);
const load = async name => JSON.parse(await readFile(new URL(name, dir), 'utf8'));
const before = await load('repro.json');
assert.equal(before.originalPageVisible, false);
assert.equal(before.visibleTextCharacters, 0);
assert.ok(before.clerkErrors.some(item => item.errors?.some(error => error.code === 'origin_invalid')));
const after = await load('after-cutover.json');
const bare = await load('bare-home-after-cutover.json');
const stability = await load('session-stability.json');
assert.equal(bare.originalPageVisible, true);
assert.equal(bare.httpStatus, 200);
assert.equal(stability.stableAcrossTokenUpdates, true);
assert.ok(stability.samples.length >= 9 && stability.samples.every(sample => sample.status === 200 && sample.applicationEnabled));
assert.ok(stability.distinctAdvertisedExpiries >= 2);
assert.equal(after.httpStatus, 200);
assert.equal(after.originalPageVisible, true);
assert.equal(after.gatewayDiagnosticElements, 0);
assert.ok(after.visibleTextCharacters > 80 && after.renderedNavigationRegions > 0 && after.knownOriginalProductText);
assert.equal(after.clerkErrors.length, 0);
assert.equal(after.errors.filter(error => error.type === 'pageerror').length, 0);
assert.equal(after.emptyHeatmapMessage, false);
assert.ok(after.heatmapData?.status === 200 && after.heatmapData.strikeCount > 0 && after.heatmapData.matrixRows > 0 && after.heatmapData.finiteSpot);
assert.equal(after.noLongUpstreamCookies, true);
assert.equal(after.noStoredJwtObserved, true);
assert.ok(after.fetchResponses.some(response => response.url.endsWith('/api/edge/cookies') && response.status === 200));
assert.ok(after.fetchResponses.some(response => response.url.endsWith('/api/sse/ticket') && response.status === 200));
assert.ok(after.blockedExternalHosts.length > 0, 'Company-browser direct upstream access must be disabled in this acceptance run');
const result = { verifiedAt: new Date().toISOString(), origin: 'http://127.0.0.1:48175',
  originalHomepageBlackScreenFixed: true, realUpstreamHeatmapRendered: true,
  bareHomeVisible: true, sourceRefreshStabilityVerified: true,
  protectedAccessSamples: stability.samples.length, distinctAdvertisedExpiries: stability.distinctAdvertisedExpiries,
  gatewayDiagnosticPageUsedAsSuccess: false, directExternalAccessBlocked: true,
  longUpstreamCookiesObserved: false, jwtInLocalStorageObserved: false,
  fullWebsiteReady: false, allRealtimeProtocolsVerified: false,
  limitations: ['Other pages and business writes are not fully validated',
    'Version-pinned frontend adapter must be revalidated after upstream bundle changes',
    'Windows intermediary browser helper is required; not a standalone all-in-one image'],
};
await writeFile(new URL('homepage-summary.json', dir), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
