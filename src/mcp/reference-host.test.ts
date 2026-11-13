import { createJsonSchemaValidator } from './schema.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function launch(t: any, decision: string, extra: Record<string, unknown> = {}, terminal = true, raw = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'second-host24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); const state = join(root, 'state'); await mkdir(workspace, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const config = join(root, 'config.json'); await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: state, principalId: 'second-host-fixture', sessionId: root, adapterPath: '/missing/fixture-adapter', actionProfile: 'full', approvalTimeoutMs: 3000, ...extra }), { mode: 0o600 });
  const host = fileURLToPath(new URL('../../dist/examples/approval-host/main.js', import.meta.url));
  await assert.doesNotReject(readFile(host), 'separate executable reference host must exist');
  const nodeArgs = [process.execPath, host, '--config', config];
  const command = 'python3';
  const args = [fileURLToPath(new URL('./fixtures/pty-host.py', import.meta.url)), terminal ? decision : 'no-tty', ...nodeArgs];
  const child = raw ? spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', TMPDIR: root } }) : undefined;
  const exited = child ? new Promise<number | null>(resolve => child.once('exit', resolve)) : undefined;
  const transport = child ? new StdioServerTransport(child.stdout!, child.stdin!) : new StdioClientTransport({ command, args, stderr: 'pipe', env: { PATH: process.env.PATH ?? '', TMPDIR: root } });
  let display = ''; (child?.stderr ?? (transport as StdioClientTransport).stderr)?.on('data', chunk => display += chunk.toString());
  if (child) t.after(() => { child.stdin!.end(); if (child.exitCode === null) child.kill('SIGTERM'); });
  const client = new Client({ name: 'actual-second-host', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => client.close()); await client.connect(transport).catch(error => { throw new Error(`${error.message}; stderr: ${display}`); });
  return { client, transport, workspace, state, display: () => display, endInput: () => child?.stdin!.end(), exited };
}
for (const decision of ['allow', 'deny', 'cancel', 'wait']) test(`real separate host terminal ${decision} produces only its authorized effect`, { timeout: 15000 }, async t => {
  const f = await launch(t, decision, { approvalTimeoutMs: decision === 'wait' ? 200 : 3000 });
  const result = await f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'effect.txt', content: 'harmless second host proof' } });
  assert.equal((result.structuredContent as any).success, decision === 'allow');
  assert.match(f.display(), /Decision \[allow\/deny\/cancel\]/);
  assert.match(f.display(), /harmless second host proof/); assert.ok(f.display().includes(join(f.workspace, 'effect.txt')));
  assert.doesNotMatch(f.display(), /approvalId|operationId|"mac"|"nonce"/);
  if (decision === 'allow') assert.equal(await readFile(join(f.workspace, 'effect.txt'), 'utf8'), 'harmless second host proof'); else await assert.rejects(readFile(join(f.workspace, 'effect.txt')));
  const audit = await readFile(join(f.state, 'audit.jsonl'), 'utf8'); assert.doesNotMatch(audit, /harmless second host proof/);
});
test('missing terminal and unrepresentable complete prompt fail visibly without effects', { timeout: 15000 }, async t => {
  for (const terminal of [false, true]) {
    const f = await launch(t, 'allow', {}, terminal);
    const result = await f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'none', content: terminal ? 'x'.repeat(20_000) : 'harmless' } });
    assert.equal((result.structuredContent as any).success, false); await assert.rejects(readFile(join(f.workspace, 'none')));
    assert.match(f.display(), terminal ? /complete review exceeds/ : /Approval UI unavailable/);
  }
});
test('official MCP cancellation and Stop cancel the live terminal prompt with zero effects', { timeout: 15000 }, async t => {
  for (const mode of ['abort', 'stop']) {
    const f = await launch(t, 'wait'); const abort = new AbortController();
    const pending = f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'cancelled', content: 'none' } }, { signal: abort.signal });
    const rejected = pending.catch(error => error);
    while (!f.display().includes('Decision [allow/deny/cancel]')) await new Promise(r => setTimeout(r, 5));
    if (mode === 'abort') abort.abort(); else await f.client.callTool({ name: 'computer_use', arguments: { action: 'stop' } });
    const result = await rejected;
    if (mode === 'stop') assert.equal(result.structuredContent.status, 'cancelled');
    await assert.rejects(readFile(join(f.workspace, 'cancelled')));
  }
});
test('a delayed decision from a cancelled review cannot approve the next terminal review', { timeout: 15000 }, async t => {
  const f = await launch(t, 'stale');
  const first = f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'first', content: 'none' } });
  while (!f.display().includes('Decision [allow/deny/cancel]')) await new Promise(r => setTimeout(r, 5));
  await f.client.callTool({ name: 'computer_use', arguments: { action: 'stop' } }); await first;
  const second = await f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'second', content: 'none' } });
  assert.equal((second.structuredContent as any).success, false);
  await assert.rejects(readFile(join(f.workspace, 'second')));
});

test('stdio EOF aborts a pending approval and exits both separate host processes without replay', { timeout: 15000 }, async t => {
  const f = await launch(t, 'wait', { approvalTimeoutMs: 300_000 }, true, true);
  const pending = f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'eof', content: 'none' } }).catch(error => error);
  while (!f.display().includes('Decision [allow/deny/cancel]')) await new Promise(r => setTimeout(r, 5));
  f.endInput();
  const code = await Promise.race([f.exited, new Promise(resolve => setTimeout(() => resolve('still running'), 2000))]);
  assert.equal(code, 0); await pending;
  await assert.rejects(readFile(join(f.workspace, 'eof')));
  assert.match(await readFile(join(f.state, 'audit.jsonl'), 'utf8'), /CANCELLED/);
});
test('same-scope Stop terminates an approved active harmless subprocess before its delayed effect', { timeout: 15000 }, async t => {
  const f = await launch(t, 'allow');
  const marker = join(f.workspace, 'started'); const effect = join(f.workspace, 'late');
  const pending = f.client.callTool({ name: 'computer_use', arguments: { action: 'shell', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(effect)}, 'late'),1000)`] } });
  while (await readFile(marker).then(() => false, () => true)) await new Promise(r => setTimeout(r, 5));
  const stopped = await f.client.callTool({ name: 'computer_use', arguments: { action: 'stop' } });
  assert.equal((stopped.structuredContent as any).cancellationRequested, 1);
  assert.equal(((await pending).structuredContent as any).status, 'cancelled');
  await new Promise(r => setTimeout(r, 1100)); await assert.rejects(readFile(effect));
});
test('EOF waits for active subprocess cancellation audit before closing private state', { timeout: 15000 }, async t => {
  const f = await launch(t, 'allow', {}, true, true);
  const marker = join(f.workspace, 'active'); const effect = join(f.workspace, 'late-eof');
  const pending = f.client.callTool({ name: 'computer_use', arguments: { action: 'shell', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'active');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(effect)}, 'late'),1000)`] } }).catch(error => error);
  while (await readFile(marker).then(() => false, () => true)) await new Promise(r => setTimeout(r, 5));
  f.endInput(); assert.equal(await f.exited, 0); await pending;
  assert.match(await readFile(join(f.state, 'audit.jsonl'), 'utf8'), /CANCELLED/);
  await assert.rejects(readFile(effect));
});
