import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
export const commit = 'a'.repeat(40);
export const target = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;
export const sha = b => createHash('sha256').update(b).digest('hex');
export const identity = (version = '0.1.3') => ({ schemaVersion: 1, releaseVersion: version, source: { repository: 'OpenCoven/desktop-use', commit, dirty: false }, adapterProtocolVersion: 1, contracts: { observation: 1, capabilities: 1, canonicalActions: 1 } });
export function tar(entries) {
  const chunks = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? ''); const h = Buffer.alloc(512);
    h.write(e.path, 0, 100); h.write((e.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100);
    h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.fill(32, 148, 156); h.write(e.type ?? '0', 156); h.write('ustar\0', 257); h.write('00', 263);
    h.write([...h].reduce((a,b) => a+b, 0).toString(8).padStart(6,'0') + '\0 ',148);
    chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
export function descriptor(asset, bytes, entries) { return { asset, bytes: bytes.length, sha256: sha(bytes), entries: entries.map(e => ({ path: e.path, bytes: Buffer.byteLength(e.data), sha256: sha(e.data), executable: Boolean((e.mode ?? 0o644) & 0o111) })) }; }
export async function fixture(version = '0.1.3', options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release25-fixture-')); const id = identity(version);
  const envelope = { ok: true, version, ...id, target, ...options.envelope };
  const source = join(root, 'native.c'); const binary = join(root, 'coven-desktop-use');
  await writeFile(source, `#include <stdio.h>\nint main(void) { puts(${JSON.stringify(JSON.stringify({...envelope,...options.runtimeEnvelope}))}); return 0; }\n`);
  execFileSync('cc', [source, '-o', binary], { stdio: 'pipe' });
  const nativeEntries = [{ path: 'coven-desktop-use', data: await readFile(binary), mode: 0o755 }, { path: 'release-identity.json', data: JSON.stringify(envelope) }];
  const packageEntries = [
    { path: 'package/package.json', data: JSON.stringify({ name: '@opencoven/openclaw-desktop-use', version, exports: { '.': { import: './dist/index.js' }, './sdk': { import: './dist/src/sdk.js' }, './contracts': { import: './dist/src/contracts.js' } }, bin: { 'coven-desktop-use-mcp': './dist/src/mcp/main.js' } }) },
    { path: 'package/openclaw.plugin.json', data: JSON.stringify({ version }) },
    { path: 'package/dist/release-identity.json', data: JSON.stringify(id) },
    ...['index.js','src/sdk.js','src/contracts.js','src/mcp/main.js'].map(p => ({ path: `package/dist/${p}`, data: 'export {};\n' })),
  ];
  const pkg = tar(packageEntries), native = tar(nativeEntries);
  const manifest = { schemaVersion: 1, releaseVersion: version, source: { repository: 'OpenCoven/desktop-use', commit, tag: options.candidate ? null : `v${version}`, ref: options.candidate ? 'refs/heads/qualification' : `refs/tags/v${version}`, workflow: '.github/workflows/release.yml' }, adapterProtocolVersion: 1, contracts: id.contracts,
    package: { ...descriptor(`package-${version}.tgz`, pkg, packageEntries), name: '@opencoven/openclaw-desktop-use', version, sourceCommit: commit, adapterProtocolVersion: 1, surfaces: ['plugin','sdk','mcp'] },
    artifacts: [{ ...descriptor(`native-${target}.tar.gz`, native, nativeEntries), target, minimumOsVersion: process.platform === 'darwin' ? '15.0' : '22.04', ...(process.platform === 'linux' ? { libc: { family: 'glibc', minimumVersion: '2.35' } } : {}), signing: { status: 'not-run', url: null } }],
    qualifiedHosts: [], evidence: Object.fromEntries(['build','nativeSmoke','cleanInstall','hostedGateway','publication','graphicalAcceptance'].map(k => [k, { status: 'not-run', urls: [] }])) };
  await writeFile(join(root, manifest.package.asset), pkg); await writeFile(join(root, manifest.artifacts[0].asset), native); await writeFile(join(root, 'release.json'), JSON.stringify(manifest));
  // A controlled fixture verifier is deliberately only on this child process PATH.
  const gh = join(root, 'gh');
  await writeFile(gh, `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2); if(a.includes('--help')) { console.log('--source-digest --source-ref --signer-workflow --deny-self-hosted-runners --format'); process.exit(0); }\nfs.appendFileSync(${JSON.stringify(join(root,'verifier.log'))},JSON.stringify(a)+'\\n');\nif(process.env.FIXTURE_REJECT==='1'|| !a.includes('${commit}') || !a.includes('OpenCoven/desktop-use/.github/workflows/release.yml') || !a.includes('${options.candidate ? 'refs/heads/qualification' : `refs/tags/v${version}`}')) process.exit(1);\nconsole.log('[{"fixtureOnly":true}]');\n`); await chmod(gh, 0o755);
  return { root, manifest, packageEntries, nativeEntries, env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, manifestPath: join(root,'release.json') };
}

export async function cleanup(root) {
  async function writable(p) { await chmod(p,0o700); for(const e of await readdir(p,{withFileTypes:true}))if(e.isDirectory())await writable(join(p,e.name)); }
  await writable(root);await rm(root,{recursive:true,force:true});
}
