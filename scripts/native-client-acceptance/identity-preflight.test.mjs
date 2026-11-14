import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyMacIdentity } from './identity-preflight.mjs';

test('native preflight rejects a substituted PATH helper or changed adapter before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-identity-'));
  try {
    await mkdir(join(root, 'bin')); await mkdir(join(root, 'other'));
    const adapter = join(root, 'bin/coven-desktop-use');
    const helper = join(root, 'helper');
    await writeFile(adapter, 'adapter'); await writeFile(helper, 'prepared-helper'); await chmod(helper, 0o700);
    await symlink(helper, join(root, 'bin/peekaboo'));
    await writeFile(join(root, 'other/peekaboo'), '#!/bin/sh\nexit 99\n'); await chmod(join(root, 'other/peekaboo'), 0o700);
    const hash = text => createHash('sha256').update(text).digest('hex');
    await writeFile(join(root, 'baseline.json'), JSON.stringify({ nativeSha256: hash('adapter'), helperSha256: hash('prepared-helper') }));
    await verifyMacIdentity(root, adapter, join(root, 'bin'));
    await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'other')), /PATH must select/);
    await writeFile(adapter, 'different-adapter');
    await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'bin')), /adapter differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
