import assert from 'node:assert/strict';
import test from 'node:test';
import { inside,waylandLease,validateWaylandRun,proveWaylandUnavailable } from './wayland-run-contract.mjs';

test('containment rejects siblings, parent traversal and the root itself',()=>{
 assert.equal(inside('/owned/run','/owned/run/state'),true);
 for(const value of ['/owned/run','/owned/run-other/state','/owned/run/../state'])assert.equal(inside('/owned/run',value),false);
});
test('unavailable capture rejects timeout, denial and arbitrary backend errors',()=>{
 for(const status of ['timeout','blocked','needsApproval','error','cancelled']) {
  assert.throws(()=>proveWaylandUnavailable({request:{action:'screenshot',mode:'frontmost'},result:{details:{success:false,status,result:{ok:false}},content:[]},before:{entryFocused:true},after:{entryFocused:true}}));
 }
});
test('pointer unavailability requires the exact missing-helper outcome',()=>{
 assert.throws(()=>proveWaylandUnavailable({request:{action:'click'},result:{details:{success:false,status:'error',result:{ok:false,supported:true,backend:'wayland-click',error:'different backend error'}},content:[]},before:{entryFocused:true},after:{entryFocused:true}}));
});
test('only source-bound unavailable outcomes pass with unchanged focused controls',()=>{
 const before={entryFocused:true,clicks:[],keys:[],text:'',scrollOffset:0};
 for(const [request,status,native,outcome] of [
  [{action:'screenshot',mode:'frontmost'},'unsupported',{ok:false,supported:false,backend:'linux'},'unsupported-frontmost-capture'],
  [{action:'click'},'error',{ok:false,supported:true,backend:'wayland-click',error:'Missing required tool: ydotool.'},'missing-pointer-helper'],
 ]) {
  const result={details:{success:false,status,result:native},content:[]};
  assert.equal(proveWaylandUnavailable({request,result,before,after:structuredClone(before)}).outcome,outcome);
  assert.throws(()=>proveWaylandUnavailable({request,result,before,after:{...before,entryFocused:false}}));
  assert.throws(()=>proveWaylandUnavailable({request,result,before,after:{...before,clicks:[{x:80,y:60}]}}));
  assert.throws(()=>proveWaylandUnavailable({request,result:{...result,content:[{type:'image'}]},before,after:before}));
 }
});
test('lease preserves cleanup reserve across backward wall-clock jumps',()=>{
 let epoch=1_000_000,mono=100;const remaining=waylandLease(new Date(epoch+120_000).toISOString(),{epoch:()=>epoch,monotonic:()=>mono});
 assert.equal(remaining(),105_000);epoch-=60_000;mono+=104_999;assert.equal(remaining(),1);
 mono++;assert.throws(()=>remaining(),/cleanup reserve/);
});
test('lease requires a fresh finite explicitly zoned interval',()=>{
 for(const end of ['2026-11-15T00:00:00','invalid',new Date(0).toISOString(),new Date(1_300_000).toISOString()])assert.throws(()=>waylandLease(end,{epoch:()=>0,monotonic:()=>0}));
});

function sample() {
 const config={schemaVersion:1,sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),scale:2,consumerRoot:'/consumer',harnessRoot:'/consumer/run-harness',packageRoot:'/consumer/node_modules/package',runRoot:'/owned/run',runtimeRoot:'/owned/run/runtime',fixtureStatePath:'/owned/run/state.json',peerObserverPath:'/consumer/run-harness/observer.py',adapterPath:'/owned/adapter',packageArchivePath:'/owned/package.tgz',fixtureSourcePath:'/consumer/run-harness/fixture.py',swayConfigPath:'/owned/run/sway-config',imageProofPath:'/consumer/run-harness/proof.py',ptyHostPath:'/consumer/run-harness/pty.py',swaySocket:'/owned/run/runtime/sway-ipc.1000.32.sock',waylandDisplay:'wayland-1'};
 config.harnessCommit='c'.repeat(40);config.harnessTree='d'.repeat(40);config.harnessSources={'scripts/native-client-acceptance/wayland-client.mjs':'a'.repeat(64)};
 config.fileBindings=[...new Set([config.adapterPath,config.packageArchivePath,config.peerObserverPath,config.fixtureSourcePath,config.swayConfigPath,config.imageProofPath,config.ptyHostPath,config.packageRoot+'/package.json'])].map(path=>({path,sha256:'a'.repeat(64)}));
 const options={platform:'linux',uid:1000,packageRoot:config.packageRoot,workerPath:config.peerObserverPath,environment:{NATIVE_OWNED_DISPOSABLE_DISPLAY:'yes',XDG_SESSION_TYPE:'wayland',XDG_RUNTIME_DIR:config.runtimeRoot,SWAYSOCK:config.swaySocket,WAYLAND_DISPLAY:config.waylandDisplay}};
 return {config,options};
}
test('run contract accepts only explicitly owned prepared artifacts',()=>{const x=sample();assert.equal(validateWaylandRun(x.config,x.options),true);});
for(const variant of ['root','ambient-session','foreign-worker','unbound-native','foreign-package','public-runtime','duplicate-binding','unknown-scale'])test(`run contract rejects ${variant}`,()=>{
 const x=sample();
 if(variant==='root')x.options.uid=0;
 if(variant==='ambient-session')delete x.options.environment.NATIVE_OWNED_DISPOSABLE_DISPLAY;
 if(variant==='foreign-worker')x.config.peerObserverPath='/other/worker.py';
 if(variant==='unbound-native')x.config.fileBindings=x.config.fileBindings.filter(item=>item.path!==x.config.adapterPath);
 if(variant==='foreign-package')x.options.packageRoot='/other/package';
 if(variant==='public-runtime')x.config.runtimeRoot='/run/user/1000';
 if(variant==='duplicate-binding')x.config.fileBindings.push(x.config.fileBindings[0]);
 if(variant==='unknown-scale')x.config.scale=3;
 assert.throws(()=>validateWaylandRun(x.config,x.options));
});
