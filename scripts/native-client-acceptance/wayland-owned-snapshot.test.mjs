import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureOwnedWaylandSnapshot } from './wayland-owned-snapshot.mjs';

function example() {
 const rect={x:0,y:0,width:1280,height:960};
 const config={fixturePid:42,fixtureStartTicks:'123',compositorPid:32,compositorStartTicks:'100',fixtureExecutablePath:'/usr/bin/python3.11',fixtureTitle:'Owned Wayland Fixture',peerObserverPath:fileURLToPath(new URL('./wayland-peer-observer.py',import.meta.url))};
 const reply={peerPid:32,peerUid:1000,version:{variant:'sway',major:1,minor:7,patch:0,human_readable:'1.7'},outputs:[{name:'HEADLESS-1',active:true,make:'headless',model:'headless',rect,scale:1,transform:'normal',current_mode:{width:1280,height:960}}],tree:{nodes:[{id:5,pid:42,name:config.fixtureTitle,focused:true,rect}]}};
 const options={platform:'linux',environment:{NATIVE_OWNED_DISPOSABLE_DISPLAY:'yes',XDG_SESSION_TYPE:'wayland'},uid:1000,now:()=>1000,monotonic:()=>1000};
 return {config,reply,options};
}
test('worker runs isolated with bounded streams and returns only after termination',()=>{
 const x=example();let seen;
 const result=captureOwnedWaylandSnapshot(x.config,{...x.options,execute:(command,args,options)=>{
  seen={command,args,options};return {pid:123,status:0,signal:null,stdout:JSON.stringify(x.reply)};
 }});
 assert.deepEqual(seen.args.slice(0,3),['-I','-S','-B']);
 assert.equal(seen.options.killSignal,'SIGKILL');assert.equal(seen.options.timeout,4000);assert.equal(seen.options.maxBuffer,131072);
 assert.equal(Buffer.byteLength(seen.options.input)<=65536,true);assert.equal(result.metadataWorker.reaped,true);
 assert.deepEqual(Object.keys(seen.options.env).sort(),['LANG','NATIVE_OWNED_DISPOSABLE_DISPLAY','PATH']);
});
for(const [label,returned,code] of [
 ['spawn-failure',{pid:0,status:null,error:{code:'ENOENT'}},'OWNED_METADATA_SPAWN_FAILED'],
 ['timeout',{pid:123,status:null,signal:'SIGKILL',error:{code:'ETIMEDOUT'}},'OWNED_METADATA_TIMEOUT'],
 ['output-limit',{pid:123,status:null,signal:'SIGKILL',error:{code:'ENOBUFS'}},'OWNED_METADATA_OUTPUT_LIMIT'],
 ['worker-rejection',{pid:123,status:1,signal:null},'OWNED_METADATA_REJECTED'],
 ['signal',{pid:123,status:null,signal:'SIGTERM'},'OWNED_METADATA_SIGNALLED'],
 ['invalid-json',{pid:123,status:0,stdout:'{'},'OWNED_METADATA_INVALID_REPLY'],
])test(`worker classifies ${label} separately after containment`,()=>{
 const x=example();assert.throws(()=>captureOwnedWaylandSnapshot(x.config,{...x.options,execute:()=>returned}),error=>error.code===code && error.metadataWorker.reaped===true);
});
for(const phase of ['open','read','close'])test(`timed-out mock ${phase} worker cannot survive collector rejection`,()=>{
 const x=example();let child;
 assert.throws(()=>captureOwnedWaylandSnapshot(x.config,{...x.options,budgetMs:300,execute:(_command,_args,options)=>{
  child=spawnSync(process.execPath,['-e',`process.stdout.write('${phase}'); setInterval(()=>{},1000);`],options);return child;
 }}),error=>error.code==='OWNED_METADATA_TIMEOUT' && error.metadataWorker.reaped===true);
 assert.ok(child.pid>0);assert.equal(child.signal,'SIGKILL');
 assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
});
test('post-worker validation failures retain the terminated-child receipt',()=>{
 for(const change of [x=>{x.reply.peerUid=0;},x=>{x.reply.outputs[0].scale=3;},x=>{x.options.monotonic=(()=>{let call=0;return ()=>call++?999:1000;})();}]) {
  const x=example();change(x);
  assert.throws(()=>captureOwnedWaylandSnapshot(x.config,{...x.options,execute:()=>({pid:123,status:0,stdout:JSON.stringify(x.reply)})}),error=>error.code==='OWNED_METADATA_INVALID_REPLY' && error.metadataWorker.reaped===true);
 }
});
