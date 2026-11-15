// Real-event diagnostic only on the task-owned Linux display; a late effect is a failure.
import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {createDesktopClient,resolveActionPermissions} from '@opencoven/openclaw-desktop-use/sdk';
assert.equal(process.platform,'linux');assert.equal(process.env.NATIVE_OWNED_DISPOSABLE_DISPLAY,'yes');
const state=async()=>JSON.parse(await readFile('/owned/fixture-client-state.json'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const expectedPid=Number((await readFile('/owned/client-fixture.pid','utf8')).trim());
const readyEnd=Date.now()+8000;
while(Date.now()<readyEnd){const s=await state();if(s.ready&&s.pid===expectedPid)break;await delay(20);}
assert.equal((await state()).pid,expectedPid,'observe the new owned fixture before input');
async function children(pid){try{return (await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);}catch{return[];}}
const client=createDesktopClient({workspaceDir:'/owned',scope:{principalId:'queue-diagnostic',sessionId:'native'},adapterPath:'/owned/source/target/debug/coven-desktop-use',actionPermissions:resolveActionPermissions({actionProfile:'full'}),approvalProvider:()=> 'allowed',auditSink:async()=>{}});
assert.equal((await client.execute({action:'focus',windowTitle:'DesktopuseInstalledClient'},{callId:'focus'})).details.success,true);
const before=(await state()).keys.length;
const abort=new AbortController();
const pending=client.execute({action:'type-text',text:'a'.repeat(600),timeoutMs:10000},{callId:'actual-input',signal:abort.signal});
try {
let helper;
const end=Date.now()+5000;
while(!helper && Date.now()<end){for(const adapter of await children(process.pid))for(const pid of await children(adapter)){try{if((await readFile(`/proc/${pid}/comm`,'utf8')).trim()==='xdotool')helper=pid;}catch{}}await delay(10);}
assert.ok(helper,'observe actual input helper before cancellation');
while((await state()).keys.length===before && Date.now()<end)await delay(10);
assert.ok((await state()).keys.length>before);
const stopRequested=Number(process.hrtime.bigint()/1_000_000n);
await client.execute({action:'stop'},{callId:'stop'});
const outcome=await pending;
assert.equal(outcome.details.status,'cancelled');await assert.rejects(access(`/proc/${helper}`));
const settledClock=Number(process.hrtime.bigint()/1_000_000n),atReturn=(await state()).keys.length;
await delay(750);
const after=(await state()).keys,late=after.slice(atReturn);
const mod=2**32;
const ages=late.map(k=>((settledClock%mod-k.serverTimeMs+mod+mod/2)%mod)-mod/2);
const receipt={success:late.length===0,session:'virtual-x11',helperReaped:true,status:outcome.details.status,keysBefore:before,keysAtReturn:atReturn,keysAfter750ms:after.length,lateVisibleKeys:late.length,
  stopRequestedMonotonicMs:stopRequested,settledMonotonicMs:settledClock,lateEvents:late.map((k,i)=>({serverTimeMs:k.serverTimeMs,receivedMonotonicMs:k.receivedMonotonicMs,serverEventAgeAtReturnMs:ages[i]})),
  allLateEventsPredateReturn:ages.every(age=>Number.isFinite(age)&&age>=0),noLateInput:late.length===0,physicalDisplayVerified:false};
await writeFile('/owned/input-queue-diagnostic.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({success:receipt.success,lateVisibleKeys:late.length,allLateEventsPredateReturn:receipt.allLateEventsPredateReturn}));
if(!receipt.success)process.exitCode=1;
} finally {
  abort.abort();
  await pending.catch(()=>{});
}
