import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopClient } from './client.js';
import { createExecution } from './execution.js';
import { resolveActionPermissions } from '../action-permissions.js';

for (const surface of ['sdk', 'mcp'] as const) {
  test(`${surface} missing-adapter repair follows trusted construction instead of ambient plugin configuration`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery24-'))); t.after(() => rm(root, { recursive: true, force: true }));
    const ambient = process.env.COVEN_DESKTOP_USE_BIN; process.env.COVEN_DESKTOP_USE_BIN = '/ambient/plugin-adapter';
    t.after(() => { if (ambient === undefined) delete process.env.COVEN_DESKTOP_USE_BIN; else process.env.COVEN_DESKTOP_USE_BIN = ambient; });
    const adapterPath = join(root, 'explicit-adapter');
    const client = createDesktopClient({ workspaceDir: root, scope: { principalId: 'fixture' }, surface, adapterPath, auditSink: async () => {} });
    for (const action of ['health', 'doctor'] as const) {
      const result = await client.execute({ action }, { callId: action });
      assert.equal((result.details.adapterInvocation as any).configuredPath, adapterPath);
      assert.equal((result.details.adapterInvocation as any).code, 'ENOENT');
      const guidance = JSON.stringify({ result: result.details.result, repairHints: result.details.repairHints });
      assert.doesNotMatch(guidance, /COVEN_DESKTOP_USE_BIN|OpenClaw|gateway service account|ambient\/plugin-adapter/);
      assert.match(guidance, surface === 'sdk' ? /trusted SDK adapterPath/ : /trusted MCP configuration.*adapterPath/);
      assert.match(guidance, /restart.*launcher/);
    }
  });
  test(`${surface} macOS permission recovery names the effective adapter and actual launcher`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'permission24-'))); t.after(() => rm(root, { recursive: true, force: true }));
    const ambient = process.env.COVEN_DESKTOP_USE_BIN; process.env.COVEN_DESKTOP_USE_BIN = '/ambient/plugin-adapter';
    t.after(() => { if (ambient === undefined) delete process.env.COVEN_DESKTOP_USE_BIN; else process.env.COVEN_DESKTOP_USE_BIN = ambient; });
    const adapterPath = join(root, 'explicit-adapter');
    const report = JSON.parse(await readFile(new URL('../../contracts/v1/fixtures/capabilities/macos.json', import.meta.url), 'utf8')).report;
    const denied = { ok: false, platform: 'macos', code: 'PERMISSION_ERROR', capabilitiesV1: report };
    await writeFile(adapterPath, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(denied)) + ');\n', { mode: 0o700 });
    const client = createDesktopClient({ workspaceDir: root, scope: { principalId: 'fixture' }, surface, adapterPath, auditSink: async () => {} });
    for (const action of ['health', 'doctor'] as const) {
      const result = await client.execute({ action }, { callId: action });
      const flow = result.details.permissionFlow as any;
      assert.ok(flow.primaryBinariesToAdd.includes(adapterPath));
      assert.doesNotMatch(JSON.stringify(flow), /ambient\/plugin-adapter|OpenClaw|openclaw/);
      assert.match(flow.afterGrant, /restart.*launcher/);
      assert.match(flow.afterGrant, surface === 'sdk' ? /SDK/ : /MCP/);
    }
    // Non-discovery adapter failures use the same trusted guidance.
    const execution = createExecution({ adapterPath, surface, actionPermissions: resolveActionPermissions(), appendAuditEvent: async () => {}, approvalProvider: () => 'allowed', runAdapter: async () => denied });
    const result = await execution.execute('keypress', { action: 'keypress', keys: ['tab'] });
    assert.ok((result.details.permissionFlow as any).primaryBinariesToAdd.includes(adapterPath));
    assert.doesNotMatch(JSON.stringify(result.details.permissionFlow), /OpenClaw|openclaw|ambient\/plugin-adapter/);
  });
}

test('plugin permission recovery retains OpenClaw launcher guidance with the selected adapter', async () => {
  const execution = createExecution({ adapterPath: '/trusted/plugin-adapter', appendAuditEvent: async () => {}, runAdapter: async () => ({ ok: false, platform: 'macos', code: 'PERMISSION_ERROR' }) });
  const result = await execution.execute('plugin', { action: 'doctor' });
  const flow = result.details.permissionFlow as any;
  assert.ok(flow.primaryBinariesToAdd.includes('/trusted/plugin-adapter'));
  assert.match(flow.afterGrant, /OpenClaw Gateway/);
});
