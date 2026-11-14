import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packed = process.argv[2];
const main = join(packed, 'dist/src/mcp/main.js');
const { version } = JSON.parse(await readFile(join(packed, 'package.json'), 'utf8'));
const { createJsonSchemaValidator } = await import(pathToFileURL(join(packed, 'dist/src/mcp/schema.js')));
const receipts = [];
for (const harness of ['claude', 'codex', 'copilot', 'opencode', 'hermes', 'coven-code', 'grok', 'gemini', 'cursor', 'generic']) {
  const root = join(process.cwd(), `recipe-${harness}-space 雪`);
  const workspace = join(root, 'workspace'), state = join(root, 'private-state'), configPath = join(root, 'config "quoted".json');
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const rendered = spawnSync(process.execPath, [main, 'recipe', '--harness', harness, '--config', configPath, '--workspace', workspace, '--state', state, '--adapter', '/missing/fixture-adapter'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(rendered.status, 0, rendered.stderr); assert.equal(rendered.stderr, '');
  const recipe = JSON.parse(rendered.stdout);
  await assert.rejects(access(configPath)); await assert.rejects(access(join(state, 'audit.jsonl')));
  let native;
  if (recipe.configuration.format === 'toml') {
    const parsed = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: recipe.configuration.snippet, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr); native = JSON.parse(parsed.stdout).mcp_servers['coven-desktop-use'];
  } else {
    const config = JSON.parse(recipe.configuration.snippet); // Hermes receives JSON-compatible YAML.
    native = harness === 'opencode' ? config.mcp.servers['coven-desktop-use']
      : harness === 'hermes' ? config.mcp_servers['coven-desktop-use']
      : harness === 'coven-code' ? config.config.mcp_servers[0] : config.mcpServers['coven-desktop-use'];
  }
  // Derive the executable and argv from the native snippet, not a duplicated recipe-side launch object.
  const command = Array.isArray(native.command) ? native.command[0] : native.command;
  const args = Array.isArray(native.command) ? native.command.slice(1) : native.args;
  assert.equal(command, process.execPath); assert.deepEqual(args, [main, '--config', configPath]);
  await writeFile(configPath, JSON.stringify(recipe.startupConfig.value), { mode: 0o600 });
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe', env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_PATH: '' } });
  let diagnostics = ''; transport.stderr?.on('data', value => diagnostics += value);
  const client = new Client({ name: 'packed-recipe-shape-client', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), supportedProtocolVersions: ['2025-11-25'] });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, version);
    const { tools } = await client.listTools(); assert.deepEqual(tools.map(tool => tool.name), ['computer_use']);
    const health = await client.callTool({ name: 'computer_use', arguments: { action: 'health' } });
    assert.equal(health.structuredContent.capabilitiesV1.producer.surface, 'mcp');
    assert.equal((await client.callTool({ name: 'computer_use', arguments: { action: 'stop' } })).structuredContent.status, 'success');
    const denied = await client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'must-not-exist', content: 'recipe-private-content-34' } });
    assert.equal(denied.structuredContent.code, 'ACTION_PROFILE_DENIED');
    await assert.rejects(access(join(workspace, 'must-not-exist')));
  } finally { await client.close(); await transport.close(); }
  assert.equal(diagnostics, '');
  assert.doesNotMatch(await readFile(join(state, 'audit.jsonl'), 'utf8'), /recipe-private-content-34/);
  receipts.push({ harness, checkedVersion: recipe.evidence.version, qualification: recipe.qualification, format: recipe.configuration.format, compiledLaunch: true, protocol: '2025-11-25', tools: ['computer_use'], health: true, stop: true, policyDeniedWrite: true, realHarness: false, modelAliasObserved: false, nativeDesktop: false });
}
console.log(JSON.stringify({ recipeShapes: receipts, evidence: 'Official MCP client launching native-recipe command shapes from a production-only packed installation; no real harness or native desktop claim.' }));
