import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function removeOwnedPrivateFiles(root) {
  let complete = true;
  let backups = [];
  try {
    backups = (await readdir(root)).filter(name => /^openclaw\.json\.(?:last-good|bak(?:\..+)?|clobbered\..+|rejected\..+|[1-9]\d*\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp)$/.test(name));
  } catch { complete = false; }
  for (const name of ['console.log','gateway.jsonl','openclaw.json','state','home','coven-home','workspace', ...backups]) {
    try { await rm(join(root, name), { recursive: true, force: true }); }
    catch { complete = false; }
  }
  return complete;
}
