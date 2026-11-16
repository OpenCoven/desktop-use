import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../../dist/src/mcp/main.js', import.meta.url));
const ids = ['claude', 'codex', 'copilot', 'opencode', 'hermes', 'coven-code', 'grok', 'gemini', 'cursor', 'generic'];
const run = (args: string[], cwd?: string) => spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', main, 'recipe', ...args], { encoding: 'utf8', cwd, timeout: 10000 });

test('connector help makes the separate print-only recipe command discoverable', () => {
  const r = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.match(r.stderr, /recipe --harness/); assert.match(r.stderr, /--workspace/); assert.match(r.stderr, /print-only/i);
});

// Missing recipe dispatch must fail these: the ordinary startup path cannot emit a recipe or access its inputs.
for (const id of ids) test(`print-only ${id} recipe emits its native entry and honest qualification`, async () => {
  const r = run(['--harness', id]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  const recipe = JSON.parse(r.stdout);
  assert.equal(recipe.harness, id); assert.equal(recipe.serverName, 'coven-desktop-use');
  assert.equal(recipe.nodeRequirement, '>=22.14.0');
  assert.equal(recipe.qualification, ['grok', 'gemini', 'cursor', 'generic'].includes(id) ? 'unqualified' : 'recipe-only');
  assert.equal(recipe.evidence.realHarness, false); assert.equal(recipe.evidence.nativeDesktop, false);
  assert.ok(recipe.evidence.sources.length > 0);
  if (recipe.qualification === 'recipe-only') assert.match(recipe.evidence.version, /^\d+\.\d+\.\d+$/);
  assert.equal(recipe.modelVisibleTool.wireName, 'computer_use'); assert.equal(recipe.modelVisibleTool.observed, false);
  assert.equal(recipe.startupConfig.value.actionProfile, 'observation-only');
  assert.equal(recipe.startupConfig.configMode, '0600'); assert.equal(recipe.startupConfig.stateDirectoryMode, '0700');
  if (id === 'codex' || id === 'grok') {
    const parsed = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: recipe.configuration.snippet, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const entry = JSON.parse(parsed.stdout).mcp_servers['coven-desktop-use'];
    assert.equal(entry.command, process.execPath); assert.deepEqual(entry.args, [main, '--config', '/absolute/private/desktop-use.json']);
  } else {
    const config = JSON.parse(recipe.configuration.snippet);
    const entry = id === 'opencode' ? config.mcp.servers['coven-desktop-use'] : id === 'hermes' ? config.mcp_servers['coven-desktop-use'] : id === 'coven-code' ? config.config.mcp_servers[0] : config.mcpServers['coven-desktop-use'];
    const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
    const args = Array.isArray(entry.command) ? entry.command.slice(1) : entry.args;
    assert.equal(command, process.execPath); assert.deepEqual(args, [main, '--config', '/absolute/private/desktop-use.json']);
    if (id === 'copilot') assert.equal(entry.type, 'local');
    if (id === 'coven-code') { assert.equal(entry.name, 'coven-desktop-use'); assert.equal(entry.type, 'stdio'); }
  }
});

test('recipe rendering neither reads a FIFO config nor creates state, audit or configuration files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recipe34-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'empty-home'); await mkdir(home);
  const config = join(root, 'config-fifo'); assert.equal(spawnSync('mkfifo', [config]).status, 0);
  const before = await readdir(root, { recursive: true });
  const r = run(['--harness', 'claude', '--config', config, '--workspace', join(root, 'missing-workspace'), '--state', join(root, 'missing-state'), '--adapter', join(root, 'missing-adapter')], home);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  assert.equal(JSON.parse(r.stdout).startupConfig.path, config);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});

test('recipe JSON and TOML preserve literal spaces, quotes, backslashes and Unicode without shell parsing', () => {
  const path = '/absolute/space "quote"/back\\slash/雪.json';
  for (const id of ['claude', 'codex', 'hermes', 'opencode', 'coven-code']) {
    const r = run(['--harness', id, '--config', path, '--workspace', '/absolute/work space', '--state', '/absolute/private state', '--adapter', '/absolute/bin/adapter']);
    assert.equal(r.status, 0, r.stderr);
    const recipe = JSON.parse(r.stdout);
    assert.equal(recipe.startupConfig.path, path); assert.equal(recipe.startupConfig.value.workspaceDir, '/absolute/work space');
    if (id === 'codex') {
      const parsed = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: recipe.configuration.snippet, encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stderr); assert.deepEqual(JSON.parse(parsed.stdout).mcp_servers['coven-desktop-use'].args, [main, '--config', path]);
    }
  }
});

for (const flag of ['--config', '--workspace', '--state', '--adapter']) test(`Hermes recipe refuses YAML control and line-separator characters in ${flag}`, () => {
  for (const character of ['\u0080', '\u0085', '\u0090', '\u009f', '\u2028', '\u2029']) {
    const r = run(['--harness', 'hermes', flag, `/absolute/yaml-canary-34/a${character}b`]);
    assert.equal(r.status, 1, `Unsafe YAML character U+${character.charCodeAt(0).toString(16)} must not select a different trusted path.`);
    assert.equal(r.stdout, ''); assert.equal(r.stderr, 'Desktop MCP startup unavailable [RECIPE_INVALID].\n');
  }
});

for (const args of [[], ['--harness', 'unknown'], ['--harness', 'claude', '--harness', 'codex'], ['--harness', 'claude', '--output', '/tmp/forbidden34'], ['--harness', 'claude', '--config', 'relative34'], ['--harness', 'claude', '--config', '/absolute/\npath-canary-34'], ['--harness', 'grok', '--config', '/absolute/${SECRET34}/config'], ['--harness', 'opencode', '--config', '/absolute/{file:path-canary-34}/config']]) {
  test(`invalid recipe input fails without stdout or leaking arguments: ${JSON.stringify(args.slice(0, 2))}`, () => {
    const r = run(args); assert.equal(r.status, 1); assert.equal(r.stdout, '');
    assert.match(r.stderr, /startup unavailable/); assert.doesNotMatch(r.stderr, /SECRET34|forbidden34|relative34|path-canary-34|\{file:/);
  });
}
