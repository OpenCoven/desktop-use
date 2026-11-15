import assert from 'node:assert/strict';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { normalizeWaylandSnapshot } from './wayland-scope-proof.mjs';

const observerPath=fileURLToPath(new URL('./wayland-peer-observer.py',import.meta.url));
const descriptorFields=['runtimeRoot','swaySocket','waylandDisplay','fixturePid','fixtureStartTicks','compositorPid','compositorStartTicks','fixtureExecutablePath','compositorExecutablePath','fixtureSourcePath','fixtureSourceSha256','fixtureStatePath','fixtureTitle','swayConfigPath','swayConfigSha256','peerObserverPath','peerObserverSha256'];

function rejected(code,result) {
  const error=new Error(code);error.code=code;
  // spawnSync returns only after its direct child has terminated. The worker
  // starts no descendants, so its pending I/O cannot survive that return.
  error.metadataWorker={pid:result.pid??0,started:(result.pid??0)>0,reaped:true,status:result.status??null,signal:result.signal??null};
  return error;
}

// All I/O occurs in one isolated child. The timeout requests termination; it is
// not a hard return deadline when the OS cannot promptly reap the child.
export function captureOwnedWaylandSnapshot(config,{platform=process.platform,environment=process.env,uid=process.getuid(),now=Date.now,monotonic=()=>performance.now(),execute=spawnSync,budgetMs=4000}={}) {
  assert.equal(platform,'linux');assert.equal(environment.NATIVE_OWNED_DISPOSABLE_DISPLAY,'yes');assert.equal(environment.XDG_SESSION_TYPE,'wayland');
  assert.ok(Number.isSafeInteger(uid) && uid>0);assert.ok(Number.isSafeInteger(budgetMs) && budgetMs>=100 && budgetMs<=4000);
  assert.ok(isAbsolute(config.fixtureExecutablePath) && /^python3(?:\.\d+)?$/.test(basename(config.fixtureExecutablePath)));
  assert.equal(config.peerObserverPath,observerPath,'the metadata worker is fixed to this prepared harness');
  const descriptor=Object.fromEntries(descriptorFields.map(key=>[key,config[key]])),input=JSON.stringify(descriptor);
  assert.ok(Buffer.byteLength(input)<=65536,'metadata descriptor exceeds its byte limit');
  const startedAtMs=now(),startedMonotonicMs=monotonic();
  const result=execute(config.fixtureExecutablePath,['-I','-S','-B',observerPath,'--descriptor-stdin','--timeout-ms',String(Math.min(3500,budgetMs-50))],{input,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',NATIVE_OWNED_DISPOSABLE_DISPLAY:'yes'},encoding:'utf8',timeout:budgetMs,killSignal:'SIGKILL',maxBuffer:131072});
  if(result.error) {
    const code=result.error.code==='ETIMEDOUT'?'OWNED_METADATA_TIMEOUT':result.error.code==='ENOBUFS'?'OWNED_METADATA_OUTPUT_LIMIT':'OWNED_METADATA_SPAWN_FAILED';
    throw rejected(code,result);
  }
  if(result.signal)throw rejected('OWNED_METADATA_SIGNALLED',result);
  if(result.status!==0)throw rejected('OWNED_METADATA_REJECTED',result);
  let observed;
  try {observed=JSON.parse(result.stdout);} catch {throw rejected('OWNED_METADATA_INVALID_REPLY',result);}
  try {
    assert.equal(observed.peerPid,config.compositorPid);assert.equal(observed.peerUid,uid);
    const snapshot=normalizeWaylandSnapshot({...observed,fixturePid:config.fixturePid,fixtureTitle:config.fixtureTitle});
    const finishedAtMs=now(),finishedMonotonicMs=monotonic();
    assert.ok([startedAtMs,finishedAtMs,startedMonotonicMs,finishedMonotonicMs].every(Number.isFinite));
    assert.ok(finishedAtMs>=startedAtMs && finishedMonotonicMs>=startedMonotonicMs && finishedMonotonicMs-startedMonotonicMs<=budgetMs,'metadata interval expired or clock rolled backward');
    return {...snapshot,fixturePid:config.fixturePid,fixtureStartTicks:config.fixtureStartTicks,compositorPid:config.compositorPid,compositorStartTicks:config.compositorStartTicks,startedAtMs,finishedAtMs,startedMonotonicMs,finishedMonotonicMs,metadataWorker:{pid:result.pid,reaped:true,status:0}};
  } catch {
    throw rejected('OWNED_METADATA_INVALID_REPLY',result);
  }
}
