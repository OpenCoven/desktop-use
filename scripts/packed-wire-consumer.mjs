import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const packed = process.argv[2];
const main = join(packed, 'dist/src/mcp/main.js');
const reference = join(packed, 'dist/examples/approval-host/main.js');
const embedding = join(packed, 'dist/examples/embedded-client.js');
const { createJsonSchemaValidator } = await import(pathToFileURL(join(packed, 'dist/src/mcp/schema.js')));
const help = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8' });
assert.equal(help.status, 0); assert.equal(help.stdout, ''); assert.match(help.stderr, /Usage: coven-desktop-use-mcp/);
let count = 0;
async function fixture(era, decision, { host = true, expiry = 3000 } = {}) {
  const root = join(process.cwd(), `wire-${count++}`); const workspace = join(root, 'workspace'); const state = join(root, 'state');
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: state, principalId: 'packed-ui', adapterPath: '/missing/fixture-adapter', actionProfile: 'full', approvalTimeoutMs: expiry }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: host ? 'python3' : process.execPath, args: host ? [join(process.cwd(), 'pty-host.py'), decision, process.execPath, reference, '--config', config] : [main, '--config', config], stderr: 'pipe', env: { PATH: process.env.PATH, TMPDIR: root, NODE_PATH: '' } });
  let display = ''; transport.stderr?.on('data', chunk => display += chunk);
  const client = new Client({ name: 'packed-reference-client', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25');
  return { client, workspace, state, config, display: () => display };
}
for (const era of ['modern', 'legacy']) {
  const plain = await fixture(era, '', { host: false });
  try {
    const { tools } = await plain.client.listTools(); assert.deepEqual(tools.map(tool => tool.name), ['computer_use']);
    assert.equal(tools[0].inputSchema.properties.action.enum.length, 18); assert.equal(tools[0].inputSchema.additionalProperties, false);
    const health = await plain.client.callTool({ name: 'computer_use', arguments: { action: 'health' } });
    assert.equal(health.structuredContent.capabilitiesV1.producer.surface, 'mcp');
    assert.deepEqual(JSON.parse(health.content[0].text), health.structuredContent);
    const blocked = await plain.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'unapproved', content: 'private-content' } });
    assert.equal(blocked.structuredContent.status, 'needsApproval'); await assert.rejects(access(join(plain.workspace, 'unapproved')));
    const forged = await plain.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'forged', content: 'private-content', confirm: true } });
    assert.equal(forged.isError, true); assert.doesNotMatch(JSON.stringify(forged), /private-content/);
  } finally { await plain.client.close(); }
  for (const decision of ['allow', 'deny', 'cancel', 'wait', 'no-tty']) {
    const f = await fixture(era, decision, { expiry: decision === 'wait' ? 200 : 3000 });
    try {
      const result = await f.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'effect', content: 'private-content' } });
      assert.equal(result.structuredContent.success, decision === 'allow');
      if (decision === 'allow') assert.equal(await readFile(join(f.workspace, 'effect'), 'utf8'), 'private-content'); else await assert.rejects(access(join(f.workspace, 'effect')));
      assert.match(f.display(), decision === 'no-tty' ? /Approval UI unavailable/ : /Decision \[allow\/deny\/cancel\]/);
      assert.doesNotMatch(await readFile(join(f.state, 'audit.jsonl'), 'utf8'), /private-content|"mac"|"nonce"/);
    } finally { await f.client.close(); }
  }
  const stopped = await fixture(era, 'wait');
  try {
    const pending = stopped.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'stopped', content: 'private-content' } });
    const end = Date.now() + 5000;
    while (!stopped.display().includes('Decision [allow/deny/cancel]')) { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
    await stopped.client.callTool({ name: 'computer_use', arguments: { action: 'stop' } });
    assert.equal((await pending).structuredContent.status, 'cancelled'); await assert.rejects(access(join(stopped.workspace, 'stopped')));
  } finally { await stopped.client.close(); }
}
const embedded = await fixture('modern', '', { host: false }); await embedded.client.close();
const child = spawn('python3', [join(process.cwd(), 'pty-host.py'), 'allow', process.execPath, embedding, '--config', embedded.config], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
assert.equal(JSON.parse(stdout).details.success, true); assert.match(stderr, /Decision \[allow\/deny\/cancel\]/);
assert.equal(await readFile(join(embedded.workspace, 'reviewed-example.txt'), 'utf8'), 'A reviewed workspace effect.');
console.log('Compiled MCP: modern/legacy wire parity, real terminal allow/deny/cancel/expiry/missing UI/Stop, private audit, SDK embedding and stderr-only help passed.');
