// Reads the owner-provided credentials file. Values are never printed.
import { readFile } from 'node:fs/promises';

export async function loadCredentials(path = new URL('../../account-info.toml', import.meta.url)) {
  const raw = await readFile(path, 'utf8');
  const read = key => {
    const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*["'](.+?)["']\\s*$`, 'm'));
    if (!match) throw new Error(`Missing ${key} in credentials file`);
    return match[1];
  };
  const credentials = { account: read('account'), password: read('password'), loginUrl: read('login_url') };
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(credentials.account)) throw new Error('account must be an email address');
  if (credentials.password.length < 8) throw new Error('password looks too short');
  return credentials;
}

// Only the host is safe to show.
export const safeTarget = url => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return 'invalid-url'; } };
