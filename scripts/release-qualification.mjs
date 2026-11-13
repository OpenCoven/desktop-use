/** Shared release-lane invariants. These checks never grant publisher trust. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, symlink, lstat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
export const HOSTS = Object.freeze([
  Object.freeze({ version: '2026.4.26', integrity: 'sha512-KBKI7gu9d/6NxBfqnojTFcHNJvrOyyYGJ6oczaBKF7zUHVKdm78zZNQOBmwiaHQMrvhjNRo0ry9xXtaAJwhV3A==' }),
  Object.freeze({ version: '2026.11.3', integrity: 'sha512-FBq/q0TCaoA2b7qfdV0q81fHhI6RBB1zAQfJQREc1u2TlK5khVgCUsAlXskLWthyVqRz5PWEj+oOmfYgK58dHg==' }),
]);
export const NATIVE_MATRIX = Object.freeze([
  { target: 'aarch64-apple-darwin', runner: 'macos-15', platform: 'darwin', arch: 'arm64' },
  { target: 'x86_64-apple-darwin', runner: 'macos-15-intel', platform: 'darwin', arch: 'x64' },
  { target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-22.04', platform: 'linux', arch: 'x64' },
  { target: 'aarch64-unknown-linux-gnu', runner: 'ubuntu-22.04-arm', platform: 'linux', arch: 'arm64' },
].map(Object.freeze));
const atLeast = (actual, minimum) => {
  const a = actual?.split(/[.-]/).map(Number), b = minimum.split('.').map(Number);
  assert.ok(a && a.slice(0, b.length).every(Number.isFinite), 'Observed version required');
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
};
export function assertRunner(target, observed) {
  const lane = NATIVE_MATRIX.find(item => item.target === target);
  assert.ok(lane, 'Declared native target');
  for (const key of ['platform', 'arch', 'runner']) assert.equal(observed[key], lane[key], `Actual ${key}`);
  assert.equal(observed.rustHost, target, 'Native Rust host, no cross compilation');
  assert.ok(atLeast(observed.osVersion, lane.platform === 'darwin' ? '15.0' : '22.04'));
  if (lane.platform === 'linux') {
    assert.equal(observed.osId, 'ubuntu');
    assert.ok(atLeast(observed.glibc, '2.35'));
    assert.ok(atLeast(observed.kernel, '5.15'));
  }
  return lane;
}
export function assertHostInstallation(version, metadata, lock) {
  const expected = HOSTS.find(host => host.version === version);
  assert.ok(expected, 'Frozen supported or proposed host');
  assert.equal(metadata.version, expected.version, 'Actual host version');
  const entry = lock.packages?.['node_modules/openclaw'];
  assert.equal(entry?.version, expected.version, 'Installed lock host version');
  assert.equal(entry?.integrity, expected.integrity, 'Frozen host tarball integrity');
  return { expectedVersion: version, actualVersion: metadata.version, expectedIntegrity: expected.integrity, actualIntegrity: entry.integrity };
}
export async function assertLaneResolution(packed, host) {
  host = await realpath(host);
  const require = createRequire(join(packed, 'package.json'));
  const receipt = {};
  for (const [field, module] of [['pluginSdk', 'plugin-entry'], ['preflightSdk', 'state-paths']]) {
    const path = await realpath(require.resolve(`openclaw/plugin-sdk/${module}`));
    assert.ok(path.startsWith(host + sep), `${field} must resolve through selected lane host, never checkout`);
    receipt[field] = path;
    receipt[`${field}Sha256`] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return { ...receipt, host, packed: await realpath(packed), ancestorFallback: false };
}
export async function linkLaneHost(packed, host) {
  await mkdir(join(packed, 'node_modules'), { recursive: true });
  const link = join(packed, 'node_modules/openclaw');
  try { await symlink(await realpath(host), link); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(await realpath(link), await realpath(host), 'Existing lane SDK must be the exact host');
  }
  return assertLaneResolution(packed, host);
}
export function assertUpgradePair(previous, current) {
  assert.match(previous.releaseVersion, /^0\.1\.[0-9]+$/);
  assert.match(current.releaseVersion, /^0\.1\.[0-9]+$/);
  assert.ok(Number(previous.releaseVersion.split('.').at(-1)) < Number(current.releaseVersion.split('.').at(-1)), 'Real update requires a newer version');
  assert.notEqual(previous.source.commit, current.source.commit, 'Each version has its own real source identity');
}

export async function assertInstalledPackage(packed, descriptor) {
  const root = await realpath(packed);
  for (const entry of descriptor.entries) {
    assert.ok(entry.path.startsWith('package/'));
    const path = join(root, entry.path.slice('package/'.length));
    assert.ok((await realpath(path)).startsWith(root + sep), 'Installed file stays within packed package');
    assert.ok((await lstat(path)).isFile(), 'Installed runtime entry is a regular file');
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes, `Installed size: ${entry.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Installed digest: ${entry.path}`);
  }
}
export async function qualifyCandidateSequence({ previous, current, stage, activate, consume }) {
  if (previous) assertUpgradePair(previous, current);
  for (const candidate of previous ? [previous, current] : [current]) await stage(candidate);
  const sequence = previous ? [previous, current, previous, current] : [current];
  for (let index = 0; index < sequence.length; index++) {
    const candidate = sequence[index];
    const selected = await activate(candidate, index === 2 ? 'rollback' : 'activate');
    // A failed package synchronization or consumer ends qualification with the selection visible.
    await consume(candidate, selected, index);
  }
}
export function assertLoadedSdk(records, lane) {
  assert.ok(Array.isArray(records) && records.length > 0, 'Actual plugin execution must report its loaded SDK');
  for (const record of records) assert.equal(record.sdkEntry, lane.pluginSdk, 'Loaded plugin SDK equals lane preflight SDK host');
}
export function assertMinimalHttpPolicy(version, response) {
  assert.ok(HOSTS.some(host => host.version === version));
  if (version === '2026.4.26') {
    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
    return 'profile-denied';
  }
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const details = response.body.result?.details;
  assert.equal(details?.status, 'success');
  assert.equal(details.success, true);
  assert.equal(details.action, 'stop');
  assert.equal(details.cancellationRequested, 0);
  assert.equal(details.state, 'idle');
  assert.deepEqual(JSON.parse(response.body.result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')), details);
  return 'authenticated-request-expands-profile';
}

export async function createNoRustGuard(root, originalPath) {
  const directory = join(root, 'without-rust');
  const attemptsPath = join(root, 'rust-attempts.jsonl');
  await mkdir(directory, { mode: 0o700 });
  const tools = ['cargo', 'rustc', 'rustup'];
  for (const tool of tools) {
    await writeFile(join(directory, tool), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(attemptsPath)},JSON.stringify({tool:${JSON.stringify(tool)}})+'\\n',{mode:0o600});process.stderr.write('Rust tool invocation is forbidden in clean installation.\\n');process.exit(97);\n`, { mode: 0o700 });
  }
  const path = `${directory}:${originalPath ?? ''}`;
  const resolved = {};
  for (const tool of tools) {
    resolved[tool] = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'release-guard', tool], { encoding: 'utf8', env: { ...process.env, PATH: path } }).trim();
    assert.equal(resolved[tool], join(directory, tool), 'Rust tool is blocked by task-owned PATH guard');
  }
  const receipt = async () => {
    const text = await readFile(attemptsPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    return { active: true, scope: 'task-owned PATH guard; global tools remain installed', resolved, attempts: text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] };
  };
  return { path, receipt, async assertUnused() { assert.deepEqual((await receipt()).attempts, [], 'Rust tool invocation occurred during clean installation'); } };
}

const explicitDenyGuard = 'No callable tools remain after resolving explicit tool allowlist (agents.denied-qualification.tools.allow: computer_use, desktop_use); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.';
const sanitizedDeniedReply = "⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";

export function assertExplicitDenyGuard(logSuffix, { runId, sessionKey }) {
  assert.match(runId, /^[a-f0-9-]{36}$/);
  assert.equal(sessionKey, 'agent:denied-qualification:qualification');
  assert.ok(logSuffix.length <= 2 * 1024 * 1024, 'Bounded private diagnostic window required');
  const records = logSuffix.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const candidates = records.filter(record => {
    const identity = record['1'];
    if (identity?.runId !== runId) return false;
    const message = record['2'];
    if (typeof message !== 'string') return false;
    const match = message.match(/^lane task error: lane=(\S+) durationMs=\d+ error=(.+)$/);
    return match?.[1] === `session:${sessionKey}`;
  });
  assert.equal(candidates.length, 1, 'Exactly one current run/session explicit allowlist guard required');
  const candidate = candidates[0];
  assert.deepEqual(candidate['1'], { runId, sessionKey, taskKind: 'turn', errorName: 'Error' });
  assert.equal(JSON.parse(candidate['2'].match(/ error=(.+)$/)[1]), explicitDenyGuard);
  return { kind: 'exact-session-lane-explicit-allowlist-guard', runId, sessionKey, records: 1 };
}

export function assertExplicitDenyModel({ hostVersion, outcome, providerCalls, providerResponses, messages, guardEvidence, sessionKey }) {
  assert.ok(HOSTS.some(host => host.version === hostVersion), 'Exact qualified host required');
  assert.ok(Array.isArray(messages), 'Explicit-deny history required');
  for (const message of messages) {
    assert.ok(!['tool', 'toolResult'].includes(message.role), 'Explicit deny must not produce tool results');
    assert.equal(message.tool_calls?.length ?? 0, 0, 'Explicit deny must not produce tool calls');
    assert.equal(Array.isArray(message.content) && message.content.some(block => ['toolCall', 'tool_use', 'toolResult', 'tool_result'].includes(block.type)), false, 'Explicit deny must not dispatch tools');
  }
  if (outcome.status === 'error') {
    assert.equal(providerCalls, 0, 'Allowlist precheck must precede every provider request');
    assert.deepEqual(providerResponses, []);
    if (guardEvidence) {
      assert.equal(hostVersion, '2026.11.3');
      assert.equal(outcome.error, sanitizedDeniedReply);
      assert.equal(sessionKey, 'agent:denied-qualification:qualification');
      assert.deepEqual(guardEvidence, { kind: 'exact-session-lane-explicit-allowlist-guard', runId: outcome.runId, sessionKey, records: 1 });
      return 'correlated-pre-provider-explicit-allowlist-rejection';
    }
    assert.equal(outcome.error, `Error: ${explicitDenyGuard}`);
    return 'pre-provider-explicit-allowlist-rejection';
  }
  assert.equal(outcome.status, 'ok', 'Only a proven no-tool completion may succeed');
  assert.equal(providerCalls, 1);
  assert.equal(providerResponses.length, 1);
  const response = providerResponses[0];
  assert.equal(response.case, 'explicit-deny-model');
  assert.deepEqual(response.tools, []);
  assert.equal(response.finished, true);
  const assistant = messages.filter(message => message.role === 'assistant');
  assert.equal(assistant.length, 1);
  const content = assistant[0].content;
  const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
  assert.equal(text, 'Qualification explicit-deny-model complete.');
  return 'no-tool-provider-completion';
}
