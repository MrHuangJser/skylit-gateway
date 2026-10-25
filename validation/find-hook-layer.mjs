// Locate the modules that export the hooks layer and the root provider in the current build.
import { readFile, readdir } from 'node:fs/promises';
import { exportsIn } from './generate-auth-patches.mjs';

const DIR = new URL('../.local/live-chunks/', import.meta.url);
const WANT = new Set(['useAuth', 'useUser', 'useSession', 'useClerk', 'useSignIn', 'useSignUp',
  'useOrganization', 'useOrganizationList', 'ClientClerkProvider', 'ClerkProvider', 'SignedIn', 'SignedOut',
  'ClerkLoaded', 'ClerkLoading', 'UserButton', 'SignInButton', 'SignOutButton']);
for (const file of (await readdir(DIR)).filter(f => f.endsWith('.js'))) {
  const src = await readFile(new URL(file, DIR), 'utf8');
  if (!/ClientClerkProvider|useClerk/.test(src)) continue;
  let all;
  try { all = exportsIn(src); } catch { continue; }
  const grouped = new Map();
  for (const e of all) {
    if (e.moduleId === null || !WANT.has(e.name)) continue;
    grouped.set(e.moduleId, [...(grouped.get(e.moduleId) ?? []), e.name]);
  }
  for (const [id, names] of grouped) {
    if (names.length >= 2) console.log(`${file}#${id} (${names.length}) ${names.join(', ')}`);
  }
}
