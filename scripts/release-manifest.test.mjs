import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, tar, descriptor, commit } from './fixtures/release/helpers.mjs';
const api = await import('./release-manifest.mjs').catch(() => ({}));
test('manifest validator exists and snapshots recursively immutable validated input', async t => {
  assert.equal(typeof api.validateReleaseManifest, 'function');
  const f = await fixture(); t.after(() => rm(f.root,{recursive:true,force:true}));
  const value = api.validateReleaseManifest(f.manifest); f.manifest.source.commit = 'b'.repeat(40);
  assert.equal(value.source.commit, commit); assert.ok(Object.isFrozen(value.artifacts[0].entries));
});
for (const [name, mutate] of Object.entries({ schema: m=>m.schemaVersion=2, version: m=>m.package.version='0.1.4', commit: m=>m.package.sourceCommit='b'.repeat(40), protocol: m=>m.package.adapterProtocolVersion=2, target: m=>m.artifacts[0].target='x86_64-pc-windows-msvc', tag: m=>m.source.tag='main', workflow: m=>m.source.workflow='.github/workflows/other.yml', unknown: m=>m.untrusted=true, traversal: m=>m.package.entries[0].path='../outside', evidence: m=>m.evidence.build.status='passed', host: m=>m.qualifiedHosts=[{version:'latest',integrity:'sha512-x'}], duplicate: m=>m.artifacts.push(m.artifacts[0]) })) test(`rejects ${name} without echoing untrusted input`, async t => {
  assert.equal(typeof api.validateReleaseManifest,'function'); const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true})); mutate(f.manifest); assert.throws(()=>api.validateReleaseManifest(f.manifest), /^Error: RELEASE_MANIFEST_INVALID$/);
});
test('assembly hashes actual package/native archive bytes and identity, preserving absent evidence', async t=> {
  assert.equal(typeof api.assembleReleaseManifest,'function'); const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  const m=await api.assembleReleaseManifest({ ...f.manifest, assetDirectory:f.root });
  assert.equal(m.package.sha256,f.manifest.package.sha256); assert.equal(m.evidence.cleanInstall.status,'not-run');
  await writeFile(join(f.root,f.manifest.package.asset),'substituted');
  await assert.rejects(api.assembleReleaseManifest({...f.manifest,assetDirectory:f.root}));
});
for (const [name, entry] of [['traversal',{path:'../evil',data:'bad'}],['symlink',{path:'package/link',data:'',type:'2'}],['hardlink',{path:'package/link',data:'',type:'1'}],['pax',{path:'package/meta',data:'bad',type:'x'}]]) test(`archive parser rejects ${name} before extraction`,()=> {
  assert.equal(typeof api.readArchive,'function'); assert.throws(()=>api.readArchive(tar([entry])));
});
test('identity comparison is semantic across Rust and Node JSON key ordering',async t=>{
 const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
 const value={schemaVersion:1,releaseVersion:'0.1.3',source:{repository:'OpenCoven/desktop-use',commit,dirty:false},adapterProtocolVersion:1,contracts:{canonicalActions:1,capabilities:1,observation:1}};
 assert.doesNotThrow(()=>api.assertIdentity(value,f.manifest));
});
test('assembly accepts policy metadata without precomputed hashes and derives every entry',async t=>{
 const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));for(const a of [f.manifest.package,...f.manifest.artifacts]){delete a.sha256;delete a.bytes;delete a.entries;}
 const m=await api.assembleReleaseManifest({...f.manifest,assetDirectory:f.root});assert.ok(m.package.bytes>0);assert.equal(m.artifacts[0].entries.length,2);
});
