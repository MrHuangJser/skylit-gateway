import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFreshSession } from './session-refresh-policy.mjs';
const now = 1800000000;
// Synthetic and unsigned; used only to exercise scheduling, not to access any service.
const sample = expiry => ({ token: `e30.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.dGVzdA`, profile: { source: 'synthetic' } });
test('late cached token is renewed once and remains valid despite observed 14s container skew', async () => {
  const calls = [];
  const result = await selectFreshSession(async force => { calls.push(force); return sample(now + (force ? 60 : 10)); }, () => now);
  assert.deepEqual(calls, [false, true]);
  assert.ok(result.expiresAt > now + 14 + 3);
  assert.equal(result.forcedRefresh, true);
});
test('adequate normal SDK cache is retained without needless forced renewal', async () => {
  const calls = [], value = sample(now + 55);
  const result = await selectFreshSession(async force => { calls.push(force); return value; }, () => now);
  assert.deepEqual(calls, [false]); assert.equal(result.result, value); assert.equal(result.token, value.token);
});
test('insufficient renewed lifetime fails closed without looping or editing expiry', async () => {
  const calls = [];
  await assert.rejects(selectFreshSession(async force => { calls.push(force); return sample(now + 12); }, () => now), /freshness unavailable/);
  assert.deepEqual(calls, [false, true]);
});
test('expired cached token can use the normal forced SDK renewal', async () => {
  const calls = [];
  const result = await selectFreshSession(async force => { calls.push(force); return sample(now + (force ? 60 : -1)); }, () => now);
  assert.deepEqual(calls, [false, true]); assert.equal(result.expiresAt, now + 60);
});
test('unexpected lifetime and malformed tokens are not converted into new credentials', async () => {
  await assert.rejects(selectFreshSession(async () => sample(now + 301), () => now), /Unsupported session lifetime/);
  await assert.rejects(selectFreshSession(async () => ({ token: 'not-a-token' }), () => now), /Unsupported session token/);
  await assert.rejects(selectFreshSession(async () => { throw new Error('private remote details'); }, () => now), error => error.message === 'Normal SDK session read unavailable');
});
