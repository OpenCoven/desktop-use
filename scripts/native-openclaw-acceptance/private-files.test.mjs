import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeOwnedPrivateFiles } from './private-files.mjs';

test('cleanup removes host-generated credential backups and retains only unrelated metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native21-private-files-'));
  try {
    const secretFiles = ['openclaw.json', 'openclaw.json.last-good', 'openclaw.json.bak', 'openclaw.json.bak.4', 'openclaw.json.bak.before-write', 'openclaw.json.clobbered.2026-11-14', 'openclaw.json.rejected.2026-11-14', 'console.log', 'gateway.jsonl'];
    for (const name of secretFiles) await writeFile(join(root, name), 'disposable-credential');
    await mkdir(join(root, 'state')); await writeFile(join(root, 'state', 'private'), 'private-input');
    await writeFile(join(root, 'receipt.json'), '{"success":false}');
    await writeFile(join(root, 'openclaw.json.notes'), 'unrelated');
    assert.equal(await removeOwnedPrivateFiles(root), true);
    assert.deepEqual((await readdir(root)).sort(), ['openclaw.json.notes', 'receipt.json']);
    assert.equal(await removeOwnedPrivateFiles(root), true, 'cleanup is idempotent');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup unlinks a private backup symlink without following it outside the owned root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'native21-private-link-'));
  try {
    const root = join(parent, 'owned'), external = join(parent, 'external');
    await mkdir(root); await mkdir(external); await writeFile(join(external, 'keep'), 'preserved');
    await symlink(external, join(root, 'openclaw.json.last-good'));
    assert.equal(await removeOwnedPrivateFiles(root), true);
    assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'preserved');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('an uninspectable owned root cannot certify complete private cleanup', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'native21-private-missing-'));
  try { assert.equal(await removeOwnedPrivateFiles(join(parent, 'missing')), false); }
  finally { await rm(parent, { recursive: true, force: true }); }
});
