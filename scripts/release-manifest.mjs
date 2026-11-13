#!/usr/bin/env node
/** Paired release metadata. Hashes bind bytes; only publisher attestations establish trust. */
import { readFile, writeFile, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
const schema = JSON.parse(
  await readFile(new URL('../contracts/v1/release.schema.json', import.meta.url), 'utf8')
);
const validate = new Ajv({ strict: true, allErrors: false }).compile(schema);
export const REPOSITORY = 'OpenCoven/desktop-use';
export const WORKFLOW = `${REPOSITORY}/.github/workflows/release.yml`;
export const LIMIT = 64 * 1024 * 1024;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const fail = (code = 'RELEASE_MANIFEST_INVALID') => {
  throw new Error(code);
};
const freeze = (o) => {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(freeze);
    Object.freeze(o);
  }
  return o;
};
export function safePath(p) {
  return (
    typeof p === 'string' &&
    p.length <= 240 &&
    /^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(p) &&
    p.split('/').every((c) => c !== '.' && c !== '..')
  );
}
export function validateReleaseManifest(input) {
  try {
    const m = JSON.parse(JSON.stringify(input));
    if (
      !validate(m) ||
      m.package.version !== m.releaseVersion ||
      m.package.sourceCommit !== m.source.commit ||
      m.package.adapterProtocolVersion !== m.adapterProtocolVersion
    ) {
      fail();
    }
    if (
      m.source.tag === null
        ? !/^refs\/(heads\/|pull\/)/.test(m.source.ref) ||
          m.evidence.publication.status !== 'not-run'
        : m.source.tag !== `v${m.releaseVersion}` ||
          m.source.ref !== `refs/tags/v${m.releaseVersion}`
    ) {
      fail();
    }
    const assets = [m.package, ...m.artifacts];
    if (
      new Set(assets.map((a) => a.asset)).size !== assets.length ||
      new Set(m.artifacts.map((a) => a.target)).size !== m.artifacts.length ||
      new Set(m.qualifiedHosts.map((h) => h.version)).size !== m.qualifiedHosts.length
    ) {
      fail();
    }
    for (const a of assets) {
      if (
        new Set(a.entries.map((e) => e.path)).size !== a.entries.length ||
        a.entries.some((e) => !safePath(e.path)) ||
        a.entries.reduce((n, e) => n + e.bytes, 0) > 128 * 1024 * 1024
      ) {
        fail();
      }
      for (const e of a.entries) {
        if (a.entries.some((other) => other.path.startsWith(e.path + '/'))) {
          fail();
        }
      }
    }
    if (m.package.entries.some((e) => !e.path.startsWith('package/'))) {
      fail();
    }
    for (const a of m.artifacts) {
      const linux = a.target.endsWith('linux-gnu');
      if (
        a.minimumOsVersion !== (linux ? '22.04' : '15.0') ||
        (linux ? !a.libc : a.libc !== undefined)
      ) {
        fail();
      }
      if (
        a.entries.length !== 2 ||
        !a.entries.some((e) => e.path === 'coven-desktop-use' && e.executable) ||
        !a.entries.some((e) => e.path === 'release-identity.json' && !e.executable)
      ) {
        fail();
      }
      if ((a.signing.status === 'not-run') !== (a.signing.url === null)) {
        fail();
      }
    }
    for (const e of Object.values(m.evidence)) {
      if (e.status === 'not-run' ? e.urls.length !== 0 : e.urls.length === 0) {
        fail();
      }
    }
    for (const h of m.qualifiedHosts) {
      if ((h.status === 'not-run') !== (h.evidenceUrl === null)) {
        fail();
      }
    }
    return freeze(m);
  } catch {
    fail();
  }
}
/** Reject links, extensions and ambiguous names; never pass untrusted archives to system tar. */
export function readArchive(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) {
      fail();
    }
    const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
    const entries = [];
    const names = new Set();
    let offset = 0;
    let ended = false;
    const str = (b, start, len) => {
      const v = b.subarray(start, start + len);
      const zero = v.indexOf(0);
      if (zero >= 0 && v.subarray(zero).some((n) => n !== 0)) {
        fail();
      }
      return v.subarray(0, zero < 0 ? len : zero).toString('utf8');
    };
    const oct = (b, start, len) => {
      const raw = b
        .subarray(start, start + len)
        .toString('ascii')
        .replace(/[\0 ]+$/, '');
      if (!/^[0-7]+$/.test(raw)) {
        fail();
      }
      return parseInt(raw, 8);
    };
    while (offset + 512 <= tar.length) {
      const h = tar.subarray(offset, offset + 512);
      offset += 512;
      if (h.every((n) => n === 0)) {
        if (tar.length - offset < 512 || tar.subarray(offset).some((n) => n !== 0)) {
          fail();
        }
        ended = true;
        break;
      }
      const checksum = oct(h, 148, 8);
      const sum = [...h].reduce((n, b, k) => n + (k >= 148 && k < 156 ? 32 : b), 0);
      if (sum !== checksum || h.subarray(257, 262).toString() !== 'ustar') {
        fail();
      }
      const prefix = str(h, 345, 155);
      const path = (prefix ? prefix + '/' : '') + str(h, 0, 100);
      const type = h[156];
      const size = oct(h, 124, 12);
      const mode = oct(h, 100, 8);
      if (
        !safePath(path.replace(/\/$/, '')) ||
        names.has(path) ||
        mode & 0o7000 ||
        ![0, 48, 53].includes(type) ||
        offset + size > tar.length ||
        entries.length >= 2048
      ) {
        fail();
      }
      names.add(path);
      if (type === 53) {
        if (size !== 0) {
          fail();
        }
      } else {
        entries.push({
          path,
          data: Buffer.from(tar.subarray(offset, offset + size)),
          executable: Boolean(mode & 0o111)
        });
      }
      offset += Math.ceil(size / 512) * 512;
    }
    if (
      !ended ||
      !entries.length ||
      entries.some((e) => entries.some((o) => o.path.startsWith(e.path + '/')))
    ) {
      fail();
    }
    return entries;
  } catch {
    fail('RELEASE_ARCHIVE_INVALID');
  }
}
export async function readRegular(path, limit = LIMIT) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > limit) {
    fail('RELEASE_FILE_INVALID');
  }
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await fh.stat();
    if (actual.ino !== st.ino || actual.dev !== st.dev || actual.size !== st.size) {
      fail('RELEASE_FILE_INVALID');
    }
    const data = Buffer.alloc(st.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fh.read(data, offset, data.length - offset, null);
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== st.size) {
      fail('RELEASE_FILE_INVALID');
    }
    return data.subarray(0, offset);
  } finally {
    await fh.close();
  }
}
export function describeArchive(asset, bytes) {
  return {
    asset,
    bytes: bytes.length,
    sha256: sha256(bytes),
    entries: readArchive(bytes).map((e) => ({
      path: e.path,
      bytes: e.data.length,
      sha256: sha256(e.data),
      executable: e.executable
    }))
  };
}
export function assertIdentity(identity, manifest, target) {
  if (
    !identity ||
    identity.schemaVersion !== 1 ||
    identity.releaseVersion !== manifest.releaseVersion ||
    identity.source?.repository !== REPOSITORY ||
    identity.source?.commit !== manifest.source.commit ||
    identity.source?.dirty !== false ||
    identity.adapterProtocolVersion !== 1 ||
    !identity.contracts ||
    Object.keys(identity.contracts).length !== 3 ||
    Object.entries(manifest.contracts).some(([k, v]) => identity.contracts[k] !== v) ||
    (target &&
      (identity.ok !== true ||
        identity.version !== manifest.releaseVersion ||
        identity.target !== target))
  ) {
    fail('RELEASE_IDENTITY_MISMATCH');
  }
}
export function assertNativeArchitecture(data, target) {
  const arm = target.startsWith('aarch64');
  const linux = target.endsWith('linux-gnu');
  if (
    data.length < 32 ||
    (linux
      ? !(
          data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
          data[4] === 2 &&
          data[5] === 1 &&
          data.readUInt16LE(18) === (arm ? 183 : 62)
        )
      : !(
          data.readUInt32LE(0) === 0xfeedfacf &&
          data.readUInt32LE(4) === (arm ? 0x0100000c : 0x01000007)
        ))
  ) {
    fail('RELEASE_ARCHITECTURE_MISMATCH');
  }
}
export function inspectPair(m, packageBytes, nativeBytes, artifact) {
  const pkg = readArchive(packageBytes),
    native = readArchive(nativeBytes);
  const json = (entries, path) =>
    JSON.parse(entries.find((e) => e.path === path)?.data.toString() ?? 'null');
  const p = json(pkg, 'package/package.json');
  if (
    p?.name !== m.package.name ||
    p.version !== m.releaseVersion ||
    json(pkg, 'package/openclaw.plugin.json')?.version !== m.releaseVersion ||
    p.scripts?.postinstall ||
    p.scripts?.preinstall ||
    p.scripts?.install
  ) {
    fail('RELEASE_PACKAGE_MISMATCH');
  }
  for (const [name, path] of [
    ['.', './dist/index.js'],
    ['./sdk', './dist/src/sdk.js'],
    ['./contracts', './dist/src/contracts.js']
  ]) {
    if (
      p.exports?.[name]?.import !== path ||
      !pkg.some((e) => e.path === 'package/' + path.slice(2))
    ) {
      fail('RELEASE_PACKAGE_MISMATCH');
    }
  }
  if (
    p.bin?.['coven-desktop-use-mcp'] !== './dist/src/mcp/main.js' ||
    !pkg.some((e) => e.path === 'package/dist/src/mcp/main.js')
  ) {
    fail('RELEASE_PACKAGE_MISMATCH');
  }
  assertIdentity(json(pkg, 'package/dist/release-identity.json'), m);
  assertIdentity(json(native, 'release-identity.json'), m, artifact.target);
  const executable = native.find((e) => e.path === 'coven-desktop-use');
  if (!executable?.executable) {
    fail('RELEASE_PACKAGE_MISMATCH');
  }
  assertNativeArchitecture(executable.data, artifact.target);
  return { pkg, native };
}
/** Input carries release policy/evidence; byte sizes, hashes and entries are derived, never trusted. */
export async function assembleReleaseManifest({ assetDirectory, ...input }) {
  const m = structuredClone(input);
  if (
    !m.package ||
    !Array.isArray(m.artifacts) ||
    m.artifacts.length < 1 ||
    m.artifacts.length > 4 ||
    [m.package, ...m.artifacts].some(
      (a) =>
        !a ||
        typeof a.asset !== 'string' ||
        a.asset.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(tgz|tar\.gz)$/.test(a.asset)
    )
  ) {
    fail();
  }
  const pkg = await readRegular(join(assetDirectory, m.package.asset));
  Object.assign(m.package, describeArchive(m.package.asset, pkg));
  for (const artifact of m.artifacts) {
    const bytes = await readRegular(join(assetDirectory, artifact.asset));
    Object.assign(artifact, describeArchive(artifact.asset, bytes));
    inspectPair(m, pkg, bytes, artifact);
  }
  return validateReleaseManifest(m);
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => null)) === fileURLToPath(import.meta.url)
) {
  try {
    const [policyPath, assetDirectory, output] = process.argv.slice(2);
    if (!policyPath || !assetDirectory || !output || process.argv.length !== 5) {
      fail('USAGE: release-manifest.mjs POLICY_JSON ASSET_DIRECTORY OUTPUT_JSON');
    }
    const manifest = await assembleReleaseManifest({
      ...JSON.parse(await readRegular(policyPath, 2 * 1024 * 1024)),
      assetDirectory: resolve(assetDirectory)
    });
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(`${output}.sha256`, `${sha256(bytes)}  ${output.split('/').at(-1)}\n`, {
      flag: 'wx',
      mode: 0o600
    });
    console.log(
      JSON.stringify({
        status: 'assembled',
        manifest: resolve(output),
        provenance: 'not-verified',
        sha256: sha256(bytes)
      })
    );
  } catch (e) {
    console.error(
      e.message.startsWith('RELEASE_') || e.message.startsWith('USAGE:')
        ? e.message
        : 'RELEASE_ASSEMBLY_FAILED'
    );
    process.exitCode = 1;
  }
}
