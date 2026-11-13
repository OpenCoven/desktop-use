import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

test('executable embedding example uses the actual terminal provider and SDK without MCP transport', async t => {
  const entry = fileURLToPath(new URL('../../dist/examples/embedded-client.js', import.meta.url));
  await assert.doesNotReject(readFile(entry), 'executable embedding example must exist');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'embedding24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state'), { mode: 0o700 }); await mkdir(join(root, 'workspace'), { mode: 0o700 });
  const config = join(root, 'config'); await writeFile(config, JSON.stringify({ workspaceDir: join(root, 'workspace'), stateDir: join(root, 'state'), principalId: 'embedding-fixture', adapterPath: '/missing/fixture-adapter', actionProfile: 'full' }), { mode: 0o600 });
  const child = spawn('python3', [fileURLToPath(new URL('./fixtures/pty-host.py', import.meta.url)), 'allow', process.execPath, entry, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const code = await new Promise(resolve => child.once('exit', resolve)); assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).details.success, true); assert.match(stderr, /Decision \[allow\/deny\/cancel\]/);
  assert.equal(await readFile(join(root, 'workspace', 'reviewed-example.txt'), 'utf8'), 'A reviewed workspace effect.');
});
