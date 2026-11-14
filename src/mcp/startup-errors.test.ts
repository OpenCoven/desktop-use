import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, writeFile, chmod, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const main = fileURLToPath(new URL('../../dist/src/mcp/main.js', import.meta.url));
const cases = [
  ['arguments', 'ARGUMENTS_INVALID'], ['missing-config', 'CONFIG_UNAVAILABLE'],
  ['malformed-config', 'CONFIG_INVALID'], ['public-config', 'CONFIG_UNSAFE'],
  ['config-directory', 'CONFIG_UNSAFE'], ['config-symlink', 'CONFIG_UNAVAILABLE'],
  ['unknown-key', 'CONFIG_INVALID'], ['relative-adapter', 'ADAPTER_PATH_INVALID'],
  ['public-state', 'STATE_DIRECTORY_UNAVAILABLE'], ['missing-state', 'STATE_DIRECTORY_UNAVAILABLE'],
  ['audit-directory', 'AUDIT_UNAVAILABLE'], ['audit-symlink', 'AUDIT_UNAVAILABLE'],
  ['audit-public', 'AUDIT_UNAVAILABLE'], ['approval-descriptor', 'APPROVAL_DESCRIPTOR_UNAVAILABLE'],
] as const;

// A generic message, raw OS error or exception stack must fail this diagnostic boundary.
for (const [scenario, code] of cases) test(`startup classifies ${scenario} without leaking input or emitting protocol bytes`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'private-startup-canary34-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 });
  const configPath = join(root, 'private-config-canary34.json');
  const adapter = join(root, 'adapter.cjs'), marker = join(root, 'unexpected-effect');
  await writeFile(adapter, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`, { mode: 0o700 });
  const config: Record<string, unknown> = { workspaceDir: root, stateDir: state, principalId: 'private-principal-canary34', adapterPath: adapter };
  if (scenario === 'unknown-key') config.unknown = 'private-value-canary34';
  if (scenario === 'relative-adapter') config.adapterPath = 'private-adapter-canary34';
  if (scenario === 'public-state') await chmod(state, 0o755);
  if (scenario === 'missing-state') config.stateDir = join(root, 'absent');
  if (scenario === 'audit-directory') await mkdir(join(state, 'audit.jsonl'));
  if (scenario === 'audit-symlink') await symlink(join(root, 'private-audit-target34'), join(state, 'audit.jsonl'));
  if (scenario === 'audit-public') await writeFile(join(state, 'audit.jsonl'), '', { mode: 0o644 });
  if (scenario === 'config-directory') await mkdir(configPath);
  else if (scenario !== 'missing-config') await writeFile(configPath, scenario === 'malformed-config' ? 'private-value-canary34' : JSON.stringify(config), { mode: 0o600 });
  if (scenario === 'public-config') await chmod(configPath, 0o622);
  if (scenario === 'config-symlink') { const target = join(root, 'config-target'); await writeFile(target, JSON.stringify(config), { mode: 0o600 }); await rm(configPath); await symlink(target, configPath); }
  const args = scenario === 'arguments' ? ['--unknown', 'private-argument-canary34'] : ['--config', configPath];
  if (scenario === 'approval-descriptor') args.push('--approval-socket', join(root, 'approval.sock'), '--approval-secret-fd', '0');
  const result = spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.error?.message);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, `Desktop MCP startup unavailable [${code}].\n`);
  assert.doesNotMatch(result.stderr, /canary34|\/|Error:|at |ENOENT|EACCES/);
  await assert.rejects(readFile(marker));
});
