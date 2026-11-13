import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, chmod, realpath, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('startup rejects missing trusted authority and unsafe audit destinations with protocol-only stdout', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'startup24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const scenario of ['missing-scope', 'unknown-key', 'public-state', 'audit-symlink', 'malformed']) {
    const state = join(root, scenario); await mkdir(state, { mode: 0o700 });
    const config: Record<string, unknown> = { workspaceDir: root, stateDir: state, principalId: 'fixture', adapterPath: '/missing/fixture-adapter' };
    if (scenario === 'missing-scope') delete config.principalId;
    if (scenario === 'unknown-key') config.secret = 'private-startup-value';
    if (scenario === 'public-state') await chmod(state, 0o755);
    if (scenario === 'audit-symlink') await symlink(join(root, 'private-target'), join(state, 'audit.jsonl'));
    const path = join(root, scenario + '.json'); await writeFile(path, scenario === 'malformed' ? 'private-startup-value' : JSON.stringify(config), { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./main.ts', import.meta.url)), '--config', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = ''; let stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 1);
    assert.equal(stdout, ''); assert.match(stderr, /startup unavailable/); assert.doesNotMatch(stderr, /private-startup-value/);
  }
});

test('oversized actual stdio message closes the process before any effect or audit', { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bounded24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 });
  const config = join(root, 'config'); await writeFile(config, JSON.stringify({ workspaceDir: root, stateDir: state, principalId: 'fixture', adapterPath: '/missing/fixture-adapter' }), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./main.ts', import.meta.url)), '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value); child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'computer_use', arguments: { action: 'file-write', path: 'oversize', content: 'x'.repeat(2 * 1024 * 1024) } } }) + '\n');
  assert.equal(await exited, 0); assert.equal(stdout, ''); assert.match(stderr, /MCP transport error; diagnostics withheld/);
  assert.equal(await readFile(join(state, 'audit.jsonl'), 'utf8'), ''); await assert.rejects(readFile(join(root, 'oversize')));
});
