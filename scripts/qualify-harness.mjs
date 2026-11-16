#!/usr/bin/env node
// Real-harness qualification (#35): runs a real harness binary against the desktop-use MCP connector, a fixture
// adapter and a deterministic local model endpoint, then emits a sanitized L1/L2 receipt.
//
//   node scripts/qualify-harness.mjs --harness <id> [--variant <name>] [--bin <path>] [--connector built|packed|<tarball.tgz>|<main.js>]
//                                    [--level L1|L2] [--timeout <seconds>] [--out <receipt.json>] [--keep]
//
// Exit codes: 0 pass, 1 fail, 2 unqualified, 64 usage. A missing binary, a harness without a recipe or a harness that
// never reaches the endpoint is `unqualified` with a reason, never a pass. Disposable HOME, XDG and harness config
// directories only; the operator's own harness configuration and credentials are never read. Fixture adapter only:
// a receipt here is real-harness evidence, not native desktop acceptance.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createModelEndpoint } from './harness-qualification/endpoint.mjs';
import { HARNESSES } from './harness-qualification/harnesses.mjs';
import { LEVELS, assertReceipt, assertSanitized, discoveryVerdict, exitCode, observationVerdict, overall, unqualified } from './harness-qualification/verdict.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const usage = message => { process.stderr.write(`${message}\nusage: qualify-harness.mjs --harness <${Object.keys(HARNESSES).join('|')}> [--variant <name>] [--bin <path>] [--connector built|packed|<tarball.tgz>|<main.js>] [--level L1|L2] [--probe-bytes <n> [--probe-text compact|pretty]] [--timeout <s>] [--out <file>] [--keep]\n`); process.exit(64); };
let options;
try {
  options = parseArgs({ options: { harness: { type: 'string' }, variant: { type: 'string', default: 'default' }, bin: { type: 'string' }, connector: { type: 'string', default: 'built' }, level: { type: 'string', default: 'L2' }, 'probe-bytes': { type: 'string' }, 'probe-text': { type: 'string', default: 'compact' }, timeout: { type: 'string', default: '150' }, out: { type: 'string' }, keep: { type: 'boolean', default: false } }, strict: true }).values;
} catch (error) { usage(error.message); }
const harness = HARNESSES[options.harness];
if (!harness) usage(`Unknown harness ${options.harness ?? '(none)'}`);
if (!harness.variants.includes(options.variant)) usage(`Unknown variant ${options.variant} for ${harness.id}`);
if (!LEVELS.includes(options.level)) usage(`Unknown level ${options.level}`);
const timeoutMs = Number(options.timeout) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usage('Timeout must be a positive number of seconds');
const requestedLevels = LEVELS.slice(0, LEVELS.indexOf(options.level) + 1);
// Budget probe (#52): replace the connector with a server whose results have an exact size.
const probeBytes = options['probe-bytes'] === undefined ? null : Number(options['probe-bytes']);
if (probeBytes !== null && !(Number.isSafeInteger(probeBytes) && probeBytes >= 256)) usage('--probe-bytes must be an integer of at least 256');
const probeText = options['probe-text'];
if (!['compact', 'pretty'].includes(probeText)) usage('--probe-text must be compact or pretty');

function displayServer() {
  if (process.platform === 'darwin') return 'quartz';
  if (process.platform === 'win32') return 'windows';
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') return 'wayland';
  if (process.env.DISPLAY || process.env.XDG_SESSION_TYPE === 'x11') return 'x11';
  return 'none';
}
const host = { os: process.platform, osRelease: release(), arch: process.arch, displayServer: displayServer(), node: process.version };
const forbidden = [homedir(), repo.replace(/\/$/, ''), tmpdir()];

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

async function emit(receipt, root) {
  assertSanitized(assertReceipt(receipt), [...forbidden, root].filter(Boolean));
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (options.out) await writeFile(resolve(options.out), text, { mode: 0o644 }); else process.stdout.write(text);
  process.stderr.write(`${harness.id}${options.variant === 'default' ? '' : ` (${options.variant})`}: ${receipt.verdict}${receipt.verdict === 'pass' ? '' : ` (${requestedLevels.map(level => `${level} ${receipt.levels[level].verdict}${receipt.levels[level].reason ? `: ${receipt.levels[level].reason}` : ''}`).join('; ')})`}\n`);
  process.exitCode = exitCode(receipt.verdict);
}

function baseReceipt(extra = {}) {
  return { schemaVersion: 1, kind: 'harness-qualification', evidenceClass: 'real-harness, fixture adapter, deterministic local endpoint (not native desktop acceptance)', recordedAt: new Date().toISOString(), requestedLevels, harness: { id: harness.id, label: harness.label, variant: options.variant, version: null }, host, ...extra };
}

async function finishUnqualified(reason, detail, extra) {
  const levels = Object.fromEntries(requestedLevels.map(level => [level, unqualified(reason, detail)]));
  await emit({ ...baseReceipt(extra), levels, verdict: overall(levels, requestedLevels) });
}

const binary = harness.blocked ? null : options.bin ? resolve(options.bin) : which(harness.binary);
if (harness.blocked) await finishUnqualified(harness.blocked.reason, harness.blocked.detail);
else if (!binary || !(await access(binary, constants.X_OK).then(() => true, () => false))) await finishUnqualified('binary-not-found', `No executable ${harness.binary} was found${options.bin ? ' at --bin' : ' on PATH'}.`);
else await qualify();

async function qualify() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktopuse-harness-')));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), state = join(root, 'state');
  for (const dir of [home, workspace, join(home, '.config'), join(home, '.local/share'), join(home, '.cache'), join(home, '.local/state')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(state, { mode: 0o700 });

  function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_update_notifier: 'false' } });
    if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status})`);
    return result.stdout;
  }

  // Connector: the repository build, this checkout packed and installed outside the repository, a given tarball
  // installed the same way, or an explicit entry point.
  async function connector() {
    if (probeBytes !== null) return { main: fileURLToPath(new URL('./harness-qualification/size-probe-server.mjs', import.meta.url)), identity: { source: 'size probe (not the desktop-use connector)', package: null, version: null, commit: null } };
    const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
    const commit = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim() || null;
    if (options.connector === 'built') {
      const main = join(repo, 'dist/src/mcp/main.js');
      if (!(await access(main).then(() => true, () => false))) throw Object.assign(new Error('Run pnpm run build first, or pass --connector packed.'), { reason: 'connector-not-built' });
      return { main, identity: { source: 'repository build', package: pkg.name, version: pkg.version, commit } };
    }
    if (options.connector === 'packed' || options.connector.endsWith('.tgz')) {
      await writeFile(join(root, 'npmrc'), '');
      let tarball = options.connector === 'packed' ? null : await realpath(resolve(options.connector));
      if (!tarball) {
        run('npm', ['run', 'build'], repo);
        tarball = join(root, JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repo))[0].filename);
      }
      const install = join(root, 'connector'); await mkdir(install);
      await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], install);
      const installed = JSON.parse(await readFile(join(install, 'node_modules', pkg.name, 'package.json'), 'utf8'));
      return { main: join(install, 'node_modules', pkg.name, 'dist/src/mcp/main.js'), identity: { source: 'packed tarball', package: installed.name, version: installed.version, commit: options.connector === 'packed' ? commit : null, tarballSha256: createHash('sha256').update(await readFile(tarball)).digest('hex') } };
    }
    // An explicit entry point (for example another worktree's build): identify it from its own package and checkout.
    const main = await realpath(resolve(options.connector));
    let dir = dirname(main), manifest = null;
    while (dir !== dirname(dir) && !(manifest = await readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse, () => null))) dir = dirname(dir);
    const explicitCommit = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: dirname(main), encoding: 'utf8' }).stdout.trim() || null;
    return { main, identity: { source: 'explicit entry point', package: manifest?.name ?? null, version: manifest?.version ?? null, commit: explicitCommit } };
  }

  // Fixture adapter: a synthetic capabilities report for doctor/health and the shared v1 PNG for screenshot.
  async function fixtureAdapter() {
    const fixture = name => join(repo, 'contracts/v1/fixtures', name);
    const bytes = await readFile(fixture('images/valid.png'));
    const receipt = JSON.parse(await readFile(fixture('observations/valid-png.json'), 'utf8'));
    const { report } = JSON.parse(await readFile(fixture(`capabilities/${process.platform === 'darwin' ? 'macos-permission-granted' : 'x11-maim'}.json`), 'utf8'));
    const adapter = join(root, 'fixture-adapter.cjs');
    await writeFile(adapter, `#!${process.execPath}\n// Qualification fixture adapter: no desktop access.\nconst fs=require('node:fs');const args=process.argv.slice(2);let result={ok:true};\nif(args[0]==='doctor')result={ok:true,platform:${JSON.stringify(report.environment.platform)},session:${JSON.stringify(report.environment.session)},capabilitiesV1:${JSON.stringify(report)}};\nif(args[0]==='screenshot'){const path=args[args.indexOf('--path')+1];fs.writeFileSync(path,Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));const observation=${JSON.stringify(receipt)};observation.capturedAtMs=Date.now();result={ok:true,path,observationV1:observation};}\nconsole.log(JSON.stringify(result));\n`, { mode: 0o700 });
    return { adapter, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64'), capabilityFixture: report.environment.platform };
  }

  const reasonMarker = `qualification-private-${randomBytes(6).toString('hex')}`;
  let endpoint, child;
  const cleanup = async () => { child?.pid && killGroup(child.pid, 'SIGKILL'); await endpoint?.stop().catch(() => {}); if (!options.keep) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
  function killGroup(pid, signal) { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} } }
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15))); });
  const connectorAlive = config => spawnSync('pgrep', ['-f', config], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length > 0;

  try {
    let target;
    try { target = await connector(); } catch (error) { await finishUnqualified(error.reason ?? 'connector-unavailable', error.message.replaceAll(root, '<run>')); return; }
    const fixture = await fixtureAdapter();
    forbidden.push(fixture.base64, reasonMarker, root);
    const cduConfig = join(root, 'desktop-use.json');
    await writeFile(cduConfig, JSON.stringify({ workspaceDir: workspace, stateDir: state, principalId: 'harness-qualification', sessionId: `${harness.id}-${randomBytes(3).toString('hex')}`, adapterPath: fixture.adapter, actionProfile: 'observation-only', ...(probeBytes === null ? {} : { probeBytes, probeText }) }), { mode: 0o600 });
    const server = { command: process.execPath, args: [target.main, '--config', cduConfig] };

    endpoint = createModelEndpoint({ protocol: harness.protocol, fixtureSha256: fixture.sha256, reason: reasonMarker });
    const { port } = await endpoint.start();
    const prompt = 'Harness qualification turn. Follow the scripted model and use the desktop tool when it asks.';
    const launch = await harness.prepare({ root, home, workspace, port, server, prompt, variant: options.variant });
    const path = [dirname(process.execPath), dirname(binary), dirname(await realpath(binary)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const env = { HOME: home, USER: 'qualification', LOGNAME: 'qualification', PATH: [...new Set(path)].join(delimiter), TMPDIR: join(root, 'tmp'), TERM: 'dumb', LANG: 'en_US.UTF-8', NO_COLOR: '1', CI: '1',
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'), ...launch.env };
    await mkdir(env.TMPDIR, { mode: 0o700 });

    const versionRun = spawnSync(binary, harness.versionArgs ?? ['--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 30_000 });
    const version = (versionRun.stdout || versionRun.stderr || '').split('\n').map(line => line.trim()).find(Boolean)?.replace(/[^\w .()+-]/g, '').slice(0, 80) || null;

    const started = Date.now();
    child = spawn(binary, launch.args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    const collect = chunk => { if (output.length < 1_000_000) output += chunk; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const exited = new Promise(done => child.on('exit', (code, signal) => done({ code, signal })));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid, 'SIGTERM'); setTimeout(() => killGroup(child.pid, 'SIGKILL'), 3000).unref(); }, timeoutMs);
    const exit = await exited; clearTimeout(timer);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    let connectorReleased = false;
    for (let i = 0; i < 50 && !(connectorReleased = !connectorAlive(cduConfig)); i++) await sleep(100);
    if (!connectorReleased) spawnSync('pkill', ['-KILL', '-f', cduConfig]);
    // Anything else still naming the run directory was started by the harness and outlived it.
    const strays = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length;
    if (strays) spawnSync('pkill', ['-KILL', '-f', root]);
    child = undefined;

    const seen = endpoint.observations();
    // The connector opens its audit file at startup, so a missing file means the harness never started it.
    seen.discovery.connectorStarted = await access(join(state, 'audit.jsonl')).then(() => true, () => false);
    const audit = await readFile(join(state, 'audit.jsonl'), 'utf8').catch(() => '');
    const auditLines = audit.split('\n').filter(Boolean);
    const debug = launch.debugLog ? await readFile(launch.debugLog, 'utf8').catch(() => '') : '';
    const notes = [...new Set([...(debug + '\n' + output).matchAll(/Skipping tool "computer_use"[^\n]{0,160}/g)].map(match => match[0].replaceAll(root, '<run>')))].slice(0, 3);

    const levels = { L1: discoveryVerdict(seen.discovery) };
    if (requestedLevels.includes('L2')) levels.L2 = observationVerdict(seen.discovery, seen.observation);
    if (!seen.discovery.endpointReached) {
      const reason = timedOut ? 'harness-timed-out-before-endpoint' : 'harness-exited-before-endpoint';
      for (const level of requestedLevels) levels[level] = unqualified(reason, `The harness ${timedOut ? 'timed out' : `exited (${exit.code ?? exit.signal})`} without a model request.`);
    }
    const receipt = {
      ...baseReceipt(),
      harness: { id: harness.id, label: harness.label, variant: options.variant, version, recipe: harness.recipe, endpointProtocol: harness.protocol, requestedModels: seen.requestedModels },
      connector: { ...target.identity, launch: 'node <connector main.js> --config <disposable config>', actionProfile: 'observation-only' },
      adapter: { kind: 'fixture', capabilityFixture: fixture.capabilityFixture, screenshotFixture: 'contracts/v1/fixtures/images/valid.png', screenshotSha256: fixture.sha256 },
      run: { exitCode: exit.code, signal: exit.signal, timedOut, seconds, modelRequests: seen.requests, toolBearingRequests: seen.toolRequests, scriptCompleted: seen.finished, unexpectedEndpointPaths: seen.unexpectedPaths },
      discovery: { mode: seen.discovery.mode ?? 'listed', ...(seen.discovery.search ? { search: seen.discovery.search } : {}), desktopTools: seen.discovery.desktopTools.map(({ callName, namespace, ...tool }) => tool), otherToolCount: seen.discovery.otherToolCount, otherTools: seen.discovery.otherTools, laterListings: seen.laterListings, harnessNotes: notes },
      observation: seen.observation,
      lifecycle: { connectorStarted: seen.discovery.connectorStarted, connectorReleasedAfterHarnessExit: connectorReleased, otherProcessesAfterHarnessExit: strays, auditEvents: auditLines.length, auditFreeOfPrivateInput: !audit.includes(reasonMarker) && !audit.includes(fixture.base64) },
      ...(probeBytes === null ? {} : { probe: { targetBytes: probeBytes, text: probeText } }),
      levels,
    };
    receipt.verdict = overall(levels, requestedLevels);
    if (options.keep) process.stderr.write(`Kept run directory: ${root}\n`);
    await emit(receipt, root);
  } finally {
    await cleanup();
  }
}
