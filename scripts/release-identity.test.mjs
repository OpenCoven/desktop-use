import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const api=await import('./release-identity.mjs').catch(()=>({}));
test('package identity reflects current full source and refuses to call dirty source a verified release',()=>{
 assert.equal(typeof api.buildIdentity,'function');const identity=api.buildIdentity('0.1.3');
 assert.equal(identity.source.commit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
 const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim()!=='';assert.equal(identity.source.dirty,dirty);assert.equal(identity.releaseVersion,'0.1.3');assert.equal(identity.adapterProtocolVersion,1);
});
test('native --version preserves JSON semantics and adds actual source/target/protocol identity',()=>{
 const out=JSON.parse(execFileSync('cargo',['run','--quiet','--','--version'],{encoding:'utf8',env:{...process.env,CARGO_BUILD_JOBS:'2'}}));
 assert.equal(out.ok,true);assert.equal(out.version,'0.1.4');assert.equal(out.releaseVersion,out.version);assert.equal(out.source.commit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());assert.equal(out.adapterProtocolVersion,1);assert.equal(out.contracts.observation,1);assert.match(out.target,/^(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu)$/);
});
test('a nested or unrelated checkout cannot borrow a parent repository source identity',async t=>{
 const {mkdtemp,mkdir,rm}=await import('node:fs/promises');await mkdir('target',{recursive:true});const root=await mkdtemp('target/release25-identity-');t.after(()=>rm(root,{recursive:true,force:true}));
 const out=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {buildIdentity} from ${JSON.stringify(new URL('./release-identity.mjs',import.meta.url).href)};console.log(JSON.stringify(buildIdentity('0.1.3')));`],{cwd:root,encoding:'utf8'}));assert.equal(out.source.commit,null);assert.equal(out.source.dirty,true);
});
