import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, chmod, realpath, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('startup rejects missing trusted authority and unsafe audit destinations with protocol-only stdout', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'startup24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const scenario of ['missing-scope', 'unknown-key', 'public-state', 'audit-symlink', 'audit-public', 'audit-hardlink', 'audit-directory', 'config-symlink', 'config-directory', 'malformed']) {
    const state = join(root, scenario); await mkdir(state, { mode: 0o700 });
    const config: Record<string, unknown> = { workspaceDir: root, stateDir: state, principalId: 'fixture', adapterPath: '/missing/fixture-adapter' };
    if (scenario === 'missing-scope') delete config.principalId;
    if (scenario === 'unknown-key') config.secret = 'private-startup-value';
    if (scenario === 'public-state') await chmod(state, 0o755);
    if (scenario === 'audit-symlink') await symlink(join(root, 'private-target'), join(state, 'audit.jsonl'));
    if (scenario === 'audit-public') await writeFile(join(state, 'audit.jsonl'), '', { mode: 0o644 });
    if (scenario === 'audit-hardlink') { await writeFile(join(state, 'audit.jsonl'), '', { mode: 0o600 }); await link(join(state, 'audit.jsonl'), join(root, 'audit-alias')); }
    if (scenario === 'audit-directory') await mkdir(join(state, 'audit.jsonl'));
    const path = join(root, scenario + '.json'); await writeFile(path, scenario === 'malformed' ? 'private-startup-value' : JSON.stringify(config), { mode: 0o600 });
    if (scenario === 'config-symlink') { const target = join(root, 'config-target'); await writeFile(target, JSON.stringify(config), { mode: 0o600 }); await rm(path); await symlink(target, path); }
    if (scenario === 'config-directory') { await rm(path); await mkdir(path); }
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

for (const scenario of ['config-fifo', 'audit-fifo']) test(`${scenario} startup exits with fixed diagnostics without a FIFO counterpart`, { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fifo24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 });
  const config = join(root, 'config');
  const adapter = join(root, 'adapter'); const effect = join(root, 'effect');
  await writeFile(adapter, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' + JSON.stringify(effect) + ', "unexpected adapter execution");\n', { mode: 0o700 });
  if (scenario === 'audit-fifo') await writeFile(config, JSON.stringify({ workspaceDir: root, stateDir: state, principalId: 'fixture', adapterPath: adapter }), { mode: 0o600 });
  const fifo = scenario === 'config-fifo' ? config : join(state, 'audit.jsonl');
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('mkfifo', ['-m', '600', fifo]).status, 0);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./main.ts', import.meta.url)), '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let exceededBound = false;
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  const timer = setTimeout(() => { exceededBound = true; child.kill('SIGKILL'); }, 3000);
  const result = await closed; clearTimeout(timer);
  assert.equal(exceededBound, false, `${scenario} blocked until exact owned child was killed and reaped`);
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(stdout, '');
  assert.equal(stderr, `Desktop MCP startup unavailable [${scenario === 'config-fifo' ? 'CONFIG_UNSAFE' : 'AUDIT_UNAVAILABLE'}].\n`);
  await assert.rejects(readFile(effect));
});
