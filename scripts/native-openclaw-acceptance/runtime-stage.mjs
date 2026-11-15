// Optional, explicitly trusted offline dependency selection. Never installs or repairs.
import assert from 'node:assert/strict';
import { readFile, lstat, realpath, readdir, readlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, delimiter, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helper = { version: '2026.4.26', file: 'dist/bundled-runtime-root-DEMD7-O_.js', sha256: 'e5833b0bbb1bb21be7e8638913c2ae8ce491c0cec35432810251bc8f6e582067' };
const safePath = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');
const inside = (root, path) => path.startsWith(root + sep);
async function metadata(path, expectedHash) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  const bytes = await readFile(path);
  assert.ok(bytes.length <= 32 * 1024 * 1024, 'Bounded stage metadata required');
  assert.equal(hash(bytes), expectedHash, 'Trusted stage metadata hash mismatch');
  return JSON.parse(bytes);
}
export function runtimeStageEnvironment(verified) {
  return verified ? { OPENCLAW_PLUGIN_STAGE_DIR: verified.baseDir } : {};
}
export async function verifyStageTree({ installRoot, inventory, manifestSha256, lockSha256, deps }) {
  const root = await realpath(installRoot);
  assert.ok(Array.isArray(inventory) && inventory.length > 0 && inventory.length <= 200_000, 'Complete bounded stage inventory required');
  const expected = new Map();
  for (const entry of inventory) {
    assert.ok(safePath(entry.path) && !expected.has(entry.path), 'Unique safe stage entries required');
    expected.set(entry.path, entry);
  }
  const found = new Set(); let total = 0;
  async function walk(dir = '') {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      assert.ok(safePath(path));
      const full = join(root, path), info = await lstat(full);
      if (info.isDirectory()) { assert.ok(inside(root, await realpath(full))); await walk(path); continue; }
      const selected = expected.get(path);
      assert.ok(selected && !found.has(path), 'Every stage file must appear exactly once in the trusted inventory'); found.add(path);
      if (info.isSymbolicLink()) {
        assert.equal(await readlink(full), selected.symlink, 'Selected symlink target must match');
        assert.ok(!isAbsolute(selected.symlink) && inside(root, await realpath(full)), 'Stage links must resolve inside the selected install root');
        assert.ok(expected.has(relative(root, await realpath(full)).split(sep).join('/')), 'Stage links must resolve to an inventoried file');
      } else {
        assert.ok(info.isFile() && selected.symlink === undefined, 'Only regular files and internal file links allowed');
        assert.ok(Number.isSafeInteger(selected.bytes) && selected.bytes >= 0 && selected.bytes <= 256 * 1024 * 1024);
        assert.equal(info.size, selected.bytes); total += info.size;
        assert.ok(total <= 2 * 1024 * 1024 * 1024, 'Bounded complete stage required');
        assert.equal(Boolean(info.mode & 0o111), selected.executable);
        const bytes = await readFile(full); assert.equal(bytes.length, selected.bytes); assert.equal(hash(bytes), selected.sha256, 'Stage file bytes must match inventory');
      }
    }
  }
  await walk(); assert.equal(found.size, expected.size, 'Inventory must not omit or invent stage files');
  const manifest = await metadata(join(root, 'package.json'), manifestSha256);
  const lock = await metadata(join(root, 'package-lock.json'), lockSha256);
  const dependencies = Object.fromEntries(deps.map(dep => [dep.name, dep.version]));
  assert.equal(Object.keys(dependencies).length, deps.length, 'Conflicting dependency specs forbidden');
  assert.equal(manifest.private, true); assert.deepEqual(manifest.dependencies, dependencies, 'Manifest must match pinned host dependency scan');
  for (const key of ['optionalDependencies', 'devDependencies', 'overrides', 'workspaces']) assert.equal(manifest[key], undefined, 'No additional stage dependency authority');
  assert.equal(lock.lockfileVersion, 3); assert.deepEqual(lock.packages?.['']?.dependencies, dependencies, 'Lock root must match manifest');
  let installedPackages = 0, optionalAbsentPackages = 0;
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(safePath(path) && path.startsWith('node_modules/') && !value.link && typeof value.version === 'string', 'Resolved locked packages required');
    const entry = expected.get(`${path}/package.json`);
    if (!entry) { assert.equal(value.optional, true, 'Every required locked package must be installed'); optionalAbsentPackages++; continue; }
    const pkg = JSON.parse(await readFile(join(root, path, 'package.json')));
    assert.equal(pkg.version, value.version, 'Installed version must match retained lock'); installedPackages++;
  }
  for (const path of expected.keys()) if (/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*\/package\.json$/.test(path)) {
    assert.ok(Object.hasOwn(lock.packages, path.slice(0, -'/package.json'.length)), 'Every installed dependency must be locked');
  }
  for (const name of Object.keys(dependencies)) assert.ok(expected.has(`node_modules/${name}/package.json`), 'All directly selected dependencies must be installed');
  return { files: found.size, bytes: total, installedPackages, optionalAbsentPackages };
}
export async function verifyHostRuntimeStage(selection, { host, hostVersion, officialHostVerified } = {}) {
  if (selection === undefined) return undefined; // Ambient stage/cache selections are deliberately ignored.
  assert.equal(officialHostVerified, true, 'Stage resolver requires the unchanged verified official host');
  assert.equal(hostVersion, helper.version, 'Offline staging requires a pinned host resolver lane');
  assert.ok(isAbsolute(selection.baseDir) && !selection.baseDir.includes(delimiter), 'One explicit absolute stage base required');
  assert.ok(isAbsolute(selection.inventory), 'Explicit absolute inventory required');
  const baseDir = await realpath(selection.baseDir);
  assert.ok(!inside(baseDir, resolve(selection.inventory)) && !inside(baseDir, await realpath(selection.inventory)), 'Inventory must remain outside the stage base');
  const helperPath = join(host, helper.file);
  assert.equal(hash(await readFile(helperPath)), helper.sha256, 'Pinned official stage resolver bytes required');
  const resolver = await import(pathToFileURL(helperPath).href);
  const env = { OPENCLAW_PLUGIN_STAGE_DIR: baseDir };
  const plan = resolver.d(host, { env });
  assert.equal(plan.external, true); assert.equal(dirname(plan.installRoot), baseDir);
  assert.deepEqual(plan.searchRoots, [plan.installRoot], 'Only the selected external stage may supply runtime dependencies');
  const packageKey = relative(baseDir, plan.installRoot);
  assert.ok(safePath(packageKey) && !packageKey.includes('/'));
  assert.deepEqual((await readdir(baseDir)).sort(), [packageKey], 'Stage base must contain only the selected host package key');
  assert.equal(await realpath(plan.installRoot), plan.installRoot, 'Stage install root must not redirect');
  const inventory = await metadata(selection.inventory, selection.inventorySha256);
  assert.equal(inventory.schemaVersion, 1); assert.equal(inventory.hostVersion, hostVersion);
  assert.equal(inventory.hostPackageRoot, host, 'Stage must bind the actual installed host path');
  assert.equal(inventory.packageKey, packageKey); assert.equal(inventory.helperSha256, helper.sha256);
  const extensions = join(host, 'dist/extensions'), selectedPluginIds = [];
  for (const entry of await readdir(extensions, { withFileTypes: true })) if (entry.isDirectory()) {
    try { const plugin = JSON.parse(await readFile(join(extensions, entry.name, 'openclaw.plugin.json'))); if (plugin.providers?.length) selectedPluginIds.push(entry.name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(selectedPluginIds.length > 0, 'Pinned host provider manifests required'); selectedPluginIds.sort();
  const scan = resolver.p({ packageRoot: host, selectedPluginIds, env });
  assert.deepEqual(scan.conflicts, []); assert.ok(scan.deps.length > 0, 'Nonempty pinned host dependency plan required');
  const tree = await verifyStageTree({ installRoot: plan.installRoot, inventory: inventory.files, manifestSha256: selection.manifestSha256, lockSha256: selection.lockSha256, deps: scan.deps });
  assert.deepEqual(scan.missing, [], 'Selected external stage must satisfy every pinned provider dependency');
  return { baseDir, packageKey, inventorySha256: selection.inventorySha256, manifestSha256: selection.manifestSha256, lockSha256: selection.lockSha256, helperSha256: helper.sha256, providerManifests: selectedPluginIds.length, dependencies: scan.deps.length, missingDependencies: 0, ...tree };
}
