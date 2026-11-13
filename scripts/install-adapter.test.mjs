import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, symlink, readdir, chmod, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture, tar, descriptor, target, cleanup, commit } from './fixtures/release/helpers.mjs';
const cli=resolve('scripts/install-adapter.mjs');
const invoke=(f,command,extra=[])=>spawnSync(process.execPath,[cli,command,'--version',f.manifest.releaseVersion,'--root',join(f.root,'installed'),...extra],{env:f.env,encoding:'utf8'});
const stage=f=>invoke(f,'stage',['--manifest',f.manifestPath,'--assets',f.root,'--target',target]);
const rewrite=f=>writeFile(f.manifestPath,JSON.stringify(f.manifest));
const setup=async t=>{const f=await fixture();t.after(()=>cleanup(f.root));return f;};
test('stages a verified pair without selecting it, then explicitly activates with immutable receipt and pending host steps',async t=>{
 const f=await setup(t); const staged=stage(f); assert.equal(staged.status,0,staged.stderr); const out=JSON.parse(staged.stdout); assert.equal(out.status,'staged');
 await assert.rejects(readFile(join(f.root,'installed','active.json')));
 const verified=(await readFile(join(f.root,'verifier.log'),'utf8')).trim().split('\n').map(JSON.parse); assert.equal(verified.length,3); for(const args of verified) {assert.ok(args.includes('--deny-self-hosted-runners'));assert.ok(args.includes('https://slsa.dev/provenance/v1'));}
 const activated=invoke(f,'activate'); assert.equal(activated.status,0,activated.stderr); const active=JSON.parse(activated.stdout);assert.equal(active.status,'selected');assert.equal(active.hostSynchronization,'pending');assert.match(active.configuration.plugin,/COVEN_DESKTOP_USE_BIN=/);
 const receipt=JSON.parse(await readFile(join(f.root,'installed','versions','0.1.3','receipt.json')));assert.equal(receipt.releaseVersion,'0.1.3');assert.equal(receipt.provenance.verifier,'gh');
 assert.notEqual(stage(f).status,0);assert.equal(JSON.parse(await readFile(join(f.root,'installed','active.json'))).releaseVersion,'0.1.3');
});
for(const kind of ['provenance','hash','bytes','archive-traversal','archive-link','wrong-version','wrong-protocol','wrong-source','wrong-architecture','unknown-entry','symlink-asset'])test(`rejects ${kind} before publishing a staged version or activation`,async t=>{
 const f=kind.startsWith('wrong-')&&kind!=='wrong-architecture'?await fixture('0.1.3',{envelope:kind==='wrong-version'?{version:'0.1.2'}:kind==='wrong-protocol'?{adapterProtocolVersion:2}:{source:{repository:'attacker/repo',commit:'b'.repeat(40),dirty:false}}}):await fixture();t.after(()=>cleanup(f.root));
 if(kind==='provenance')f.env.FIXTURE_REJECT='1';
 if(kind==='hash')await writeFile(join(f.root,f.manifest.package.asset),'corrupt');
 if(kind==='bytes')f.manifest.package.bytes++;
 if(kind.startsWith('archive-')||kind==='wrong-architecture'||kind==='unknown-entry'){
  let entries=f.nativeEntries;
  if(kind==='archive-traversal')entries=[...entries,{path:'../escape',data:'bad'}];
  if(kind==='archive-link')entries=[...entries,{path:'link',data:'',type:'2'}];
  if(kind==='unknown-entry')entries=[...entries,{path:'extra',data:'bad'}];
  if(kind==='wrong-architecture'){entries[0].data=Buffer.from(entries[0].data);entries[0].data.fill(0,0,32);}
  const bytes=tar(entries);const expected=f.manifest.artifacts[0].entries; Object.assign(f.manifest.artifacts[0],descriptor(f.manifest.artifacts[0].asset,bytes,entries));if(kind==='unknown-entry')f.manifest.artifacts[0].entries=expected;
  await writeFile(join(f.root,f.manifest.artifacts[0].asset),bytes);
 }
 if(kind==='symlink-asset'){const p=join(f.root,f.manifest.package.asset);await rm(p);await symlink(join(f.root,'native.c'),p);}
 await rewrite(f);const result=stage(f);assert.notEqual(result.status,0);assert.match(result.stderr,/RELEASE_/);await assert.rejects(readFile(join(f.root,'installed','active.json')));await assert.rejects(readFile(join(f.root,'installed','versions','0.1.3','receipt.json')));
});
test('interrupted activation leaves prior selection and rollback revalidates immutable retained bytes',async t=>{
 const a=await setup(t);assert.equal(stage(a).status,0);assert.equal(invoke(a,'activate').status,0);
 const b=await fixture('0.1.4');t.after(()=>cleanup(b.root));const common=join(a.root,'installed');
 const run=(cmd,extra=[])=>spawnSync(process.execPath,[cli,cmd,'--version','0.1.4','--root',common,...extra],{env:b.env,encoding:'utf8'});
 assert.equal(run('stage',['--manifest',b.manifestPath,'--assets',b.root]).status,0);
 await mkdir(join(common,'.selection-next'));assert.notEqual(run('activate').status,0);assert.equal(JSON.parse(await readFile(join(common,'active.json'))).releaseVersion,'0.1.3');await rm(join(common,'.selection-next'),{recursive:true});
 assert.equal(run('activate').status,0);assert.equal(invoke(a,'rollback').status,0);assert.equal(JSON.parse(await readFile(join(common,'active.json'))).releaseVersion,'0.1.3');
 const binary=join(common,'versions','0.1.3','native','coven-desktop-use');await chmod(binary,0o700);await writeFile(binary,'corrupt');assert.notEqual(invoke(a,'rollback').status,0);
});
test('partial staging and symlinked installation roots never replace a previous pair',async t=>{
 const f=await setup(t);await mkdir(join(f.root,'installed'),{mode:0o700});await writeFile(join(f.root,'installed','versions'),'obstruction');assert.notEqual(stage(f).status,0);await assert.rejects(readFile(join(f.root,'installed','active.json')));
 await rm(join(f.root,'installed'),{recursive:true});await mkdir(join(f.root,'elsewhere'));await symlink(join(f.root,'elsewhere'),join(f.root,'installed'));assert.notEqual(stage(f).status,0);assert.deepEqual(await readdir(join(f.root,'elsewhere')),[]);
});
test('public CLI rejects candidate manifests and public bypass flags',async t=>{
 const f=await setup(t);f.manifest.source.tag=null;f.manifest.source.ref='refs/heads/qualification';await rewrite(f);assert.notEqual(stage(f).status,0);assert.notEqual(invoke(f,'stage',['--skip-provenance']).status,0);
});
test('trusted candidate API requires exact policy and still verifies all three artifacts',async t=>{
 const f=await fixture('0.1.3',{candidate:true});t.after(()=>cleanup(f.root));
 const invokeCandidate=sourceCommit=>spawnSync(process.execPath,['--input-type=module','-e',`import {stageCandidateRelease} from ${JSON.stringify(new URL('./install-adapter.mjs',import.meta.url).href)}; await stageCandidateRelease(${JSON.stringify({version:'0.1.3',root:join(f.root,'installed'),manifest:f.manifestPath,assets:f.root})},${JSON.stringify({sourceCommit,sourceRef:'refs/heads/qualification'})});`],{env:f.env,encoding:'utf8'});
 assert.notEqual(invokeCandidate('b'.repeat(40)).status,0);const result=invokeCandidate(commit);assert.equal(result.status,0,result.stderr);
 assert.equal((await readFile(join(f.root,'verifier.log'),'utf8')).trim().split('\n').length,3);const receipt=JSON.parse(await readFile(join(f.root,'installed','versions','0.1.3','receipt.json')));assert.equal(receipt.provenance.candidate,true);assert.equal(receipt.provenance.sourceRef,'refs/heads/qualification');assert.notEqual(invoke(f,'activate').status,0);
});
test('Cargo discovery reports the actual old version and an exact explicit path command without rewriting configuration',async t=>{
 const f=await fixture('0.1.2');t.after(()=>cleanup(f.root));const {inspectBinarySelection}=await import('./install-adapter.mjs');assert.equal(typeof inspectBinarySelection,'function');
 const home=join(f.root,'fixture-home');await mkdir(join(home,'.cargo','bin'),{recursive:true});const cargo=join(home,'.cargo','bin','coven-desktop-use');await writeFile(cargo,await readFile(join(f.root,'coven-desktop-use')),{mode:0o700});const desired=join(f.root,'installed','versions','0.1.3','native','coven-desktop-use');
 const result=await inspectBinarySelection(desired,{home,environment:{PATH:f.root}});assert.equal(result.discovery.resolvedPath,await realpath(cargo));assert.equal(result.discovery.version,'0.1.2');assert.equal(result.discovery.reason,'cargo');assert.equal(result.discovery.shadowsSelectedPair,true);assert.equal(result.configuration.sdk.adapterPath,desired);assert.ok(result.configuration.plugin.includes(desired));assert.deepEqual(await readdir(home),['.cargo']);
});

test('equivalent canonical paths do not falsely report a shadowed selected pair',async t=>{
 const f=await setup(t);const {inspectBinarySelection}=await import('./install-adapter.mjs');const p=join(f.root,'coven-desktop-use');const result=await inspectBinarySelection(p,{environment:{COVEN_DESKTOP_USE_BIN:p}});assert.equal(result.discovery.shadowsSelectedPair,false);
});
test('executes the staged native binary and rejects runtime identity despite matching archive metadata',async t=>{
 const f=await fixture('0.1.3',{runtimeEnvelope:{version:'0.1.2'}});t.after(()=>cleanup(f.root));const result=stage(f);assert.notEqual(result.status,0);assert.match(result.stderr,/RELEASE_EXECUTABLE_IDENTITY_MISMATCH/);await assert.rejects(readFile(join(f.root,'installed','versions','0.1.3','receipt.json')));
});
test('missing second artifact reports partial staging after verification without changing selection',async t=>{
 const a=await setup(t);assert.equal(stage(a).status,0);assert.equal(invoke(a,'activate').status,0);const b=await fixture('0.1.4');t.after(()=>cleanup(b.root));await rm(join(b.root,b.manifest.artifacts[0].asset));
 const result=spawnSync(process.execPath,[cli,'stage','--version','0.1.4','--root',join(a.root,'installed'),'--manifest',b.manifestPath,'--assets',b.root],{env:b.env,encoding:'utf8'});assert.notEqual(result.status,0);const state=JSON.parse(result.stderr);assert.equal(state.phase,'asset-verification');assert.equal(state.selectionChanged,false);assert.equal(JSON.parse(await readFile(join(a.root,'installed','active.json'))).releaseVersion,'0.1.3');const staged=await readdir(state.stagingDirectory);assert.ok(staged.includes('release.json'));assert.ok(!staged.includes('native'));assert.ok(!staged.includes('package'));
});
test('missing verifier fails explicitly without a checksum fallback or creating an install root',async t=>{
 const f=await setup(t);const empty=join(f.root,'empty-path');await mkdir(empty);f.env.PATH=empty;const result=stage(f);assert.notEqual(result.status,0);assert.match(result.stderr,/RELEASE_VERIFIER_REQUIRED/);await assert.rejects(readdir(join(f.root,'installed')));
});
test('npm-style bin symlinks execute the installer instead of silently importing it',async t=>{
 const f=await setup(t);const bin=join(f.root,'coven-desktop-use-install');await symlink(cli,bin);const result=spawnSync(process.execPath,[bin],{env:f.env,encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/RELEASE_USAGE/);
});
test('candidate entry point refuses missing trusted policy rather than silently adopting public policy',async t=>{
 const f=await setup(t);const code=`import {stageCandidateRelease} from ${JSON.stringify(new URL('./install-adapter.mjs',import.meta.url).href)};await stageCandidateRelease(${JSON.stringify({version:'0.1.3',root:join(f.root,'installed'),manifest:f.manifestPath,assets:f.root})});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/RELEASE_CANDIDATE_POLICY_REQUIRED/);
});
test('bare environment overrides resolve through PATH before version and shadow diagnostics',async t=>{
 const f=await setup(t);const {inspectBinarySelection}=await import('./install-adapter.mjs');const desired=join(f.root,'coven-desktop-use');const environment={...process.env,COVEN_DESKTOP_USE_BIN:'coven-desktop-use',PATH:f.root};
 const launched=JSON.parse(execFileSync(environment.COVEN_DESKTOP_USE_BIN,['--version'],{env:environment,encoding:'utf8'}));assert.equal(launched.version,'0.1.3');
 const result=await inspectBinarySelection(desired,{home:join(f.root,'unused-home'),environment});assert.equal(result.discovery.configuredPath,'coven-desktop-use');assert.equal(result.discovery.resolvedPath,await realpath(desired));assert.equal(result.discovery.version,launched.version);assert.equal(result.discovery.reason,'COVEN_DESKTOP_USE_BIN');assert.equal(result.discovery.shadowsSelectedPair,false);
});
test('dangling Cargo symlinks are skipped in favor of the executable on PATH',async t=>{
 const f=await setup(t);const {inspectBinarySelection}=await import('./install-adapter.mjs');const home=join(f.root,'fixture-home');await mkdir(join(home,'.cargo','bin'),{recursive:true});const cargo=join(home,'.cargo','bin','coven-desktop-use');await symlink(join(f.root,'missing-cargo-binary'),cargo);const desired=join(f.root,'coven-desktop-use');
 const {existsSync}=await import('node:fs');assert.equal(existsSync(cargo),false);const launched=JSON.parse(execFileSync('coven-desktop-use',['--version'],{env:{...process.env,PATH:f.root},encoding:'utf8'}));
 const result=await inspectBinarySelection(desired,{home,environment:{PATH:f.root}});assert.equal(result.discovery.resolvedPath,await realpath(desired));assert.equal(result.discovery.version,launched.version);assert.equal(result.discovery.reason,'PATH');assert.equal(result.discovery.shadowsSelectedPair,false);
});
