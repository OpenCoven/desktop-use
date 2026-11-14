import assert from 'node:assert/strict';
import { readFile, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute, resolve } from 'node:path';

export async function preparedPython(executable) {
  assert.ok(typeof executable === 'string' && isAbsolute(executable), 'prepared Python must be an absolute executable path');
  await access(executable, constants.X_OK);
  // A venv's executable is a symlink; resolving it bypasses pyvenv.cfg.
  return resolve(executable);
}

// Reject a changed/misconfigured consumer before any native action is invoked.
export async function verifyMacIdentity(root, adapter, searchPath = process.env.PATH) {
  const baseline = JSON.parse(await readFile(join(root, 'baseline.json')));
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(await realpath(adapter), await realpath(join(root, 'bin/coven-desktop-use')));
  assert.equal(await hash(adapter), baseline.nativeSha256, 'native adapter differs from prepared bytes');
  let selected;
  for (const directory of (searchPath ?? '').split(':')) {
    const candidate = join(directory || '.', 'peekaboo');
    try { await access(candidate, constants.X_OK); selected = await realpath(candidate); break; } catch {}
  }
  const expected = await realpath(join(root, 'bin/peekaboo'));
  assert.equal(selected, expected, 'PATH must select the prepared Peekaboo helper');
  assert.equal(await hash(selected), baseline.helperSha256, 'Peekaboo helper differs from prepared bytes');
  return baseline;
}
