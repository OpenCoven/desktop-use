import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyStageTree, runtimeStageEnvironment, verifyHostRuntimeStage } from './runtime-stage.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function sample() {
  const root = await mkdtemp(join(tmpdir(), 'native-stage-test-'));
  const installRoot = join(root, 'openclaw-test'); await mkdir(join(installRoot,'node_modules','example'), {recursive:true});
  const manifest = {private:true, dependencies:{example:'1.2.3'}};
  const lock = {lockfileVersion:3, packages:{'':{dependencies:manifest.dependencies}, 'node_modules/example':{version:'1.2.3',resolved:'https://registry.npmjs.org/example/-/example-1.2.3.tgz',integrity:'sha512-test'}}};
  const files = {'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock), 'node_modules/example/package.json': JSON.stringify({name:'example',version:'1.2.3'})};
  for(const [path,bytes] of Object.entries(files)) await writeFile(join(installRoot,path),bytes);
  const inventory = Object.entries(files).map(([path,bytes])=>({path,bytes:Buffer.byteLength(bytes),sha256:hash(bytes),executable:false}));
  return {root,installRoot,inventory,manifest,lock,manifestSha256:hash(files['package.json']),lockSha256:hash(files['package-lock.json']),deps:[{name:'example',version:'1.2.3'}],cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('trusted complete stage checks every byte and lock version without writing',async()=>{
 const s=await sample();try {const before=await readFile(join(s.installRoot,'package-lock.json')); const proof=await verifyStageTree(s);assert.equal(proof.files,3);assert.equal(proof.installedPackages,1);assert.deepEqual(await readFile(join(s.installRoot,'package-lock.json')),before);}finally{await s.cleanup();}
});
for(const variant of ['tampered','omitted','duplicate','escaping','symlink-escape','extra','stale-lock','manifest-deps','missing-package','unlocked-package']) test(`rejects ${variant} stage`,async()=>{
 const s=await sample();try{
  if(variant==='tampered') await writeFile(join(s.installRoot,'node_modules/example/package.json'),'changed');
  if(variant==='omitted') s.inventory.pop();
  if(variant==='duplicate') s.inventory.push(s.inventory[0]);
  if(variant==='escaping') s.inventory[0].path='../package.json';
  if(variant==='symlink-escape'){await writeFile(join(s.root,'outside'),'outside');await symlink('../../outside',join(s.installRoot,'node_modules','escape'));s.inventory.push({path:'node_modules/escape',symlink:'../../outside'});}
  if(variant==='extra') await writeFile(join(s.installRoot,'extra.js'),'extra');
  if(variant==='stale-lock'){s.lock.packages['node_modules/example'].version='9.9.9';const bytes=JSON.stringify(s.lock);await writeFile(join(s.installRoot,'package-lock.json'),bytes);s.lockSha256=hash(bytes);s.inventory[1]={...s.inventory[1],bytes:Buffer.byteLength(bytes),sha256:hash(bytes)};}
  if(variant==='manifest-deps') s.deps.push({name:'absent',version:'2.0.0'});
  if(variant==='missing-package'){await rm(join(s.installRoot,'node_modules/example'),{recursive:true});s.inventory.pop();}
  if(variant==='unlocked-package'){s.lock.packages={ '':s.lock.packages[''] };const bytes=JSON.stringify(s.lock);await writeFile(join(s.installRoot,'package-lock.json'),bytes);s.lockSha256=hash(bytes);s.inventory[1]={...s.inventory[1],bytes:Buffer.byteLength(bytes),sha256:hash(bytes)};}
  await assert.rejects(verifyStageTree(s));
 }finally{await s.cleanup();}
});
test('ambient stage is ignored; only verified trusted selection is forwarded',()=>{
 assert.deepEqual(runtimeStageEnvironment(undefined),{});
 assert.deepEqual(runtimeStageEnvironment({baseDir:'/selected/stage'}),{OPENCLAW_PLUGIN_STAGE_DIR:'/selected/stage'});
});

test('omitted stage ignores ambient state and creates nothing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-stage-ambient-'));
 const old=process.env.OPENCLAW_PLUGIN_STAGE_DIR;
 try {process.env.OPENCLAW_PLUGIN_STAGE_DIR=join(root,'must-not-exist');assert.equal(await verifyHostRuntimeStage(undefined),undefined);assert.deepEqual(await (await import('node:fs/promises')).readdir(root),[]);}
 finally {if(old===undefined)delete process.env.OPENCLAW_PLUGIN_STAGE_DIR;else process.env.OPENCLAW_PLUGIN_STAGE_DIR=old;await rm(root,{recursive:true,force:true});}
});
test('internal binary links are fully inventoried and accepted',async()=>{
 const s=await sample();try{await mkdir(join(s.installRoot,'node_modules','.bin'));await symlink('../example/package.json',join(s.installRoot,'node_modules','.bin','example'));s.inventory.push({path:'node_modules/.bin/example',symlink:'../example/package.json'});assert.equal((await verifyStageTree(s)).files,4);}finally{await s.cleanup();}
});
test('explicit stage refuses an unverified host before importing its resolver',async()=>{
 await assert.rejects(verifyHostRuntimeStage({baseDir:'/unused',inventory:'/unused.json'},{host:'/untrusted',hostVersion:'2026.4.26',officialHostVerified:false}),/unchanged verified official host/);
});
test('pinned actual official helper rejects stale package key without writes or install',async()=>{
 const host=process.env.NATIVE_OPENCLAW_HOST;assert.ok(host,'Selected installed official host required');
 const root=await mkdtemp(join(tmpdir(),'native-stage-key-'));
 try {const baseDir=join(root,'stage'),inventory=join(root,'inventory.json');await mkdir(join(baseDir,'stale-package-key'),{recursive:true});await writeFile(inventory,'{}');
 await assert.rejects(verifyHostRuntimeStage({baseDir,inventory},{host,hostVersion:'2026.4.26',officialHostVerified:true}),/selected host package key/);
 assert.deepEqual(await (await import('node:fs/promises')).readdir(baseDir),['stale-package-key']);assert.equal(await readFile(inventory,'utf8'),'{}');
 }finally{await rm(root,{recursive:true,force:true});}
});
