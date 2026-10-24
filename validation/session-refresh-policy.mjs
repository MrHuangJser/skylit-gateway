// Normal SDK renewal policy. Reads expiry for scheduling, never verifies or changes a JWT.
export async function selectFreshSession(read, clock = () => Math.floor(Date.now() / 1000), minimum = 45) {
  if (!Number.isInteger(minimum) || minimum < 5 || minimum > 120) throw new Error('Invalid session freshness policy');
  async function obtain(force) {
    let result;
    try { result = await read(force); } catch { throw new Error('Normal SDK session read unavailable'); }
    const token = result?.token;
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error('Unsupported session token');
    }
    let expiry;
    try { expiry = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp; }
    catch { throw new Error('Unsupported session token'); }
    const now = clock();
    if (!Number.isSafeInteger(expiry) || !Number.isSafeInteger(now) || expiry > now + 300) {
      throw new Error('Unsupported session lifetime');
    }
    return { result, token, expiresAt: expiry, capturedAt: now, forcedRefresh: force };
  }
  let selected = await obtain(false);
  if (selected.expiresAt - selected.capturedAt < minimum) selected = await obtain(true);
  if (selected.expiresAt - selected.capturedAt < minimum) throw new Error('Normal session freshness unavailable');
  return selected;
}
