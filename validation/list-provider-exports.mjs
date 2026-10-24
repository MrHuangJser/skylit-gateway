// List every export whose name mentions Provider, per module, in the current chunks.
import { readFile, readdir } from 'node:fs/promises';
import { exportsIn } from './generate-auth-patches.mjs';

const DIR = new URL('../.local/live-chunks/', import.meta.url);
for (const file of (await readdir(DIR)).filter(f => f.endsWith('.js'))) {
  const src = await readFile(new URL(file, DIR), 'utf8');
  if (!/Provider/.test(src)) continue;
  let all;
  try { all = exportsIn(src); } catch { continue; }
  const grouped = new Map();
  for (const e of all) if (/Provider/.test(e.name)) grouped.set(e.moduleId, [...(grouped.get(e.moduleId) ?? []), e.name]);
  for (const [id, names] of grouped) console.log(`${file}#${id}: ${names.join(', ')}`);
}
