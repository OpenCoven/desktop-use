#!/usr/bin/env node
// Installs the actual candidate outside all repository ancestors. No publication or host activity.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'desktopuse-packed24-')));
console.log(`Packed consumer evidence: ${root}`);
await writeFile(join(root, 'npmrc'), '');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: root, NODE_PATH: '', npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), npm_config_cache: join(root, 'cache') }, maxBuffer: 8 * 1024 * 1024, timeout: 180_000 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
}
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    // Build explicitly, then reserve pack stdout for JSON on all supported npm versions.
    run('npm', ['run', 'build'], repo);
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repo))[0]; tarball = join(root, packed.filename);
  }
  const sdk = join(root, 'sdk'); await mkdir(sdk);
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], sdk);
  const packageRoot = join(sdk, 'node_modules/@opencoven/openclaw-desktop-use');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(manifest.exports?.['./sdk']?.types, 'SDK must expose compiled JavaScript and declarations');
  const files = run('tar', ['-tzf', tarball]).trim().split('\n');
  assert.ok(files.every(name => !/\.test\.|fixtures\/|superpowers\/|^package\/src\/|^package\/index.ts/.test(name)), 'production package contains no tests, fixtures, private receipts or TS sources');
  for (const name of ['observation.schema.json', 'capabilities.schema.json', 'canonical-actions.json', 'canonical-actions.schema.json']) {
    assert.ok(files.includes(`package/dist/contracts/v1/${name}`), `packed runtime asset ${name}`);
  }
  for (const forbidden of ['openclaw', 'tsx', '@modelcontextprotocol/client', 'typescript']) {
    assert.ok(!run('npm', ['ls', '--all', '--parseable'], sdk).split('\n').some(path => path.endsWith('/' + forbidden)), `no production ${forbidden}`);
  }
  await cp(new URL('./packed-sdk-consumer.mjs', import.meta.url), join(sdk, 'consumer.mjs'));
  const sdkOutput = run(process.execPath, ['consumer.mjs'], sdk); console.log(sdkOutput.trim());
  const tools = join(root, 'tools'); await mkdir(tools); await writeFile(join(tools, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@modelcontextprotocol/client@2.4.0', 'typescript@6.0.3', '@types/node@25.6.0'], tools);
  await cp(new URL('./packed-type-consumer.ts', import.meta.url), join(sdk, 'consumer.ts'));
  run(process.execPath, [join(tools, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck', 'false', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', '--typeRoots', join(tools, 'node_modules/@types'), 'consumer.ts'], sdk);
  await cp(new URL('./packed-wire-consumer.mjs', import.meta.url), join(tools, 'consumer.mjs'));
  await cp(new URL('../src/mcp/fixtures/pty-host.py', import.meta.url), join(tools, 'pty-host.py'));
  const wireOutput = run(process.execPath, ['consumer.mjs', packageRoot], tools); console.log(wireOutput.trim());
  await cp(new URL('./packed-recipe-consumer.mjs', import.meta.url), join(tools, 'recipes.mjs'));
  const recipeOutput = run(process.execPath, ['recipes.mjs', packageRoot], tools); console.log(recipeOutput.trim());
  const productionLock = JSON.parse(await readFile(join(sdk, 'package-lock.json'), 'utf8'));
  const productionAudit = JSON.parse(run('npm', ['audit', '--omit=dev', '--json'], sdk));
  const receipt = { success: true, productionLock, productionAudit, node: process.version, root, tarball, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), manifest, files, productionTree: run('npm', ['ls', '--all', '--json'], sdk), sdkOutput, wireOutput, recipeOutput };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
} catch (error) { await writeFile(join(root, 'failure.txt'), String(error.stack) + '\n'); throw error; }
