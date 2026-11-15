import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerToolCallId, assertProviderLease, acceptProviderStep } from './run-contract.mjs';

const host = process.env.NATIVE_OPENCLAW_HOST;
assert.ok(host, 'Select the retained official host');
const { r: sanitize } = await import(pathToFileURL(join(host, 'dist/tool-call-id-CYE4DX47.js')));
for (const marker of ['allowed','allowed-after','forged-confirm-denied','denied-after']) for (const action of ['capture','type']) test(`Wayland ${marker}/${action} identity survives actual strict host replay`, () => {
  const id = providerToolCallId(marker, action); assert.match(id, /^[A-Za-z0-9]{1,40}$/);
  const result = sanitize([{ role:'assistant',content:[{type:'toolCall',id,name:'computer_use',arguments:{}}] }, {role:'toolResult',toolCallId:id,content:[]}], 'strict');
  assert.equal(result[0].content[0].id, id); assert.equal(result[1].toolCallId, id);
});
test('provider case and action identities cannot collide or accept arbitrary labels', () => {
  const ids = ['allowed','allowed-after','forged-confirm-denied','denied-after'].flatMap(m => ['capture','type'].map(a => providerToolCallId(m,a)));
  assert.equal(new Set(ids).size, 8); assert.throws(() => providerToolCallId('../private','type')); assert.throws(() => providerToolCallId('allowed','shell'));
});

function leaseExample() {
  const now = Date.now(), descriptor = { fixturePid:123,fixtureWindowId:5,adapterSha256:'a'.repeat(64),packageSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40),wayland:{fixturePid:123,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',scale:2} };
  descriptor.fixtureLease={acknowledgement:'native-openclaw-fixture-exclusive',ownerThread:'owned-provider-test',expiresAt:new Date(now+300_000).toISOString(),fixturePid:123,fixtureWindowId:5,adapterSha256:descriptor.adapterSha256,packageSha256:descriptor.packageSha256,sourceCommit:descriptor.sourceCommit,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',scale:2};
  const observed={fixture:{ready:true,pid:123,windowNumber:5},snapshot:{fixturePid:123,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',windowId:5,output:{scale:2}},control:{fixtureIdentity:'d'.repeat(64),entryFocused:true,textLength:0,textSha256:createHash('sha256').update('').digest('hex'),keyCount:0,clickCount:0,scrollOffset:0}};
  return {descriptor,observed,baseline:structuredClone(observed),options:{now:()=>now}};
}
test('provider lease binds exact selected actors, components, scope and unchanged controls', () => {
  const s=leaseExample(); assert.equal(assertProviderLease(s.descriptor,s.observed,s.baseline,s.options),true);
});
for (const variant of ['missing','forged-confirm','expired','unbounded','wrong-package','changed-birth','changed-compositor','wrong-window','wrong-scale','changed-identity','changed-control','lost-focus']) test(`provider lease rejects ${variant}`, () => {
  const s=leaseExample();
  if(variant==='missing')delete s.descriptor.fixtureLease;
  if(variant==='forged-confirm'){delete s.descriptor.fixtureLease;s.descriptor.confirm=true;}
  if(variant==='expired')s.descriptor.fixtureLease.expiresAt=new Date(s.options.now()-1).toISOString();
  if(variant==='unbounded')s.descriptor.fixtureLease.expiresAt=new Date(s.options.now()+3_600_001).toISOString();
  if(variant==='wrong-package')s.descriptor.fixtureLease.packageSha256='e'.repeat(64);
  if(variant==='changed-birth')s.observed.snapshot.fixtureStartTicks='112';
  if(variant==='changed-compositor')s.observed.snapshot.compositorPid=999;
  if(variant==='wrong-window')s.observed.fixture.windowNumber=6;
  if(variant==='wrong-scale')s.observed.snapshot.output.scale=1;
  if(variant==='changed-identity')s.observed.control.fixtureIdentity='f'.repeat(64);
  if(variant==='changed-control')s.observed.control.keyCount++;
  if(variant==='lost-focus')s.observed.control.entryFocused=false;
  assert.throws(()=>assertProviderLease(s.descriptor,s.observed,s.baseline,s.options),/WAYLAND_PROVIDER_LEASE_REJECTED/);
});

for(const captureOnly of [false,true])test(`provider sequence completes once with captureOnly=${captureOnly}`,()=>{
  const plan={nextResultCount:0,captureOnly}; assert.equal(acceptProviderStep(plan,0),'capture');
  assert.equal(acceptProviderStep(plan,1),captureOnly?'complete':'input');
  if(!captureOnly)assert.equal(acceptProviderStep(plan,2),'complete');
  assert.throws(()=>acceptProviderStep(plan,captureOnly?1:2),/WAYLAND_PROVIDER_SEQUENCE_REJECTED/);
});
test('provider sequence rejects repeated, skipped or reversed steps before another action',()=>{
  for(const counts of [[0,0],[1],[0,2],[0,1,1],[0,1,0],[0,1,2,0]]){
    const plan={nextResultCount:0,captureOnly:false};
    assert.throws(()=>{for(const count of counts)acceptProviderStep(plan,count);},/WAYLAND_PROVIDER_SEQUENCE_REJECTED/);
  }
});

test('pinned helper PATH survives the actual official gateway bootstrap',async()=>{
  const api=await import('./run-contract.mjs'),{spawnSync}=await import('node:child_process');
  const selected='/opt/desktopuse-helpers/grim-1.4.0-jpeg/bin',search=selected+':/usr/bin:/usr/local/bin';
  const environment=api.providerGatewayHelperEnvironment?.(search)??{PATH:search};
  const module=pathToFileURL(join(host,'dist/path-env-BMBxRDDc.js')).href;
  const code=`import {t as ensure} from ${JSON.stringify(module)};ensure();console.log(JSON.stringify({selectedFirst:process.env.PATH.split(':')[0]===${JSON.stringify(selected)},bootstrapped:process.env.OPENCLAW_PATH_BOOTSTRAPPED==='1'}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...environment,HOME:'/nonexistent-owned-qualification-home',LANG:'C.UTF-8'},encoding:'utf8'});
  assert.equal(result.status,0,'Official bootstrap must complete');assert.deepEqual(JSON.parse(result.stdout),{selectedFirst:true,bootstrapped:true});
});
test('gateway helper environment rejects malformed selections with fixed diagnostics',async()=>{
  const api=await import('./run-contract.mjs');assert.equal(typeof api.providerGatewayHelperEnvironment,'function');
  for(const value of ['',':/usr/bin','relative:/usr/bin','/usr/bin:','/usr/bin\nsecret','/usr/../bin'])assert.throws(()=>api.providerGatewayHelperEnvironment(value),/WAYLAND_PROVIDER_HELPER_PATH_REJECTED/);
});

test('diagnostic privacy classification distinguishes fixed failures without retaining payloads',async()=>{
  const api=await import('./run-contract.mjs'),privateText='owned-private-fixture';
  assert.equal(api.classifyDiagnosticPrivacy?.('ordinary bounded status',privateText),'safe');
  assert.equal(api.classifyDiagnosticPrivacy?.('prefix '+privateText+' suffix',privateText),'private-text');
  assert.equal(api.classifyDiagnosticPrivacy?.('data:image/jpeg;base64,AAAA',privateText),'image-data');
  assert.equal(api.classifyDiagnosticPrivacy?.('{"screenshot_raw":"AAAA"}',privateText),'raw-screenshot-field');
});
test('diagnostic privacy classification fails visibly on invalid inputs without echoing them',async()=>{
  const api=await import('./run-contract.mjs');assert.equal(typeof api.classifyDiagnosticPrivacy,'function');
  for(const values of [[null,'owned-private-fixture'],['ordinary',''],['ordinary',{}]])assert.equal(api.classifyDiagnosticPrivacy(...values),'invalid-diagnostic-input');
});

test('privacy file checks retain fixed read failures and treat absent files separately',async()=>{
  const api=await import('./run-contract.mjs');assert.equal(typeof api.checkDiagnosticPrivacy,'function');
  const result=await api.checkDiagnosticPrivacy(async kind=>{throw Object.assign(Error('private read detail'),{code:kind==='console'?'EACCES':'ENOENT'});},'owned-private-fixture');
  assert.deepEqual(result,{safe:false,checks:[{kind:'console',reason:'read-failure',readCode:'EACCES'},{kind:'gateway',reason:'absent'}]});assert.ok(!JSON.stringify(result).includes('private read detail'));
});
test('privacy file checks preserve the rejection of actual private text and images',async()=>{
  const api=await import('./run-contract.mjs');assert.equal(typeof api.checkDiagnosticPrivacy,'function');
  const result=await api.checkDiagnosticPrivacy(async kind=>kind==='console'?'owned-private-fixture':'data:image/png;base64,AAAA','owned-private-fixture');
  assert.deepEqual(result,{safe:false,checks:[{kind:'console',reason:'private-text'},{kind:'gateway',reason:'image-data'}]});
});
