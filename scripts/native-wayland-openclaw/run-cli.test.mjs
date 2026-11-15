import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('./run.mjs', import.meta.url));
for (const mode of ['--preflight', '--run-owned-fixture', '--unsupported']) test(`provider CLI fails safely before native setup for invalid ${mode} selection`, t => {
  const root = mkdtempSync(join(tmpdir(), 'wayland-provider-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const descriptor = join(root, 'private-descriptor.json'); writeFileSync(descriptor, '{"rawPrivate":"never-print-this"}');
  const result = spawnSync(process.execPath, [entry, descriptor, mode], { encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
  assert.equal(result.status, 1); assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { code: 'WAYLAND_PROVIDER_PREFLIGHT_REJECTED' });
  assert.deepEqual(readdirSync(root), ['private-descriptor.json']);
  assert.equal(result.stderr.includes(root), false); assert.equal(result.stderr.includes('never-print-this'), false);
});
