import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runProviderCase } from './provider-case.mjs';
import { providerToolCallId } from './run-contract.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function harness() {
  let current={fixture:{ready:true,pid:123,windowNumber:5},snapshot:{fixturePid:123,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',windowId:5,output:{scale:2}},control:{fixtureIdentity:'d'.repeat(64),entryFocused:true,textLength:0,textSha256:sha(''),keyCount:0,clickCount:0,scrollOffset:0}};
  const descriptor={fixturePid:123,fixtureWindowId:5,adapterSha256:'a'.repeat(64),packageSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40),wayland:{fixturePid:123,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',scale:2}};
  descriptor.fixtureLease={acknowledgement:'native-openclaw-fixture-exclusive',ownerThread:'unit-fixture-owner',expiresAt:new Date(Date.now()+300_000).toISOString(),fixturePid:123,fixtureWindowId:5,adapterSha256:descriptor.adapterSha256,packageSha256:descriptor.packageSha256,sourceCommit:descriptor.sourceCommit,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',scale:2};
  const context={descriptor,session:'agent:computer-use:wayland21',plannedText:'owned-test',control:{check(){}},fixture:()=>structuredClone(current),expectedObservation:structuredClone(current),plans:new Map(),events:[],activeRuns:new Set(),approvals:[],setPhase(){},assertHealthy(){},delay:async()=>{},until:async predicate=>{const result=await predicate();assert.ok(result);return result;}};
  context.rpc=async(method,args)=>{
    if(method==='agent'){
      const marker=args.message.split(':')[1],plan=context.plans.get(marker);plan.responses=plan.captureOnly?2:3;plan.nextResultCount=null;
      if(!plan.captureOnly)context.events.push({event:'plugin.approval.requested',payload:{id:marker,request:{toolCallId:providerToolCallId(marker,'type')}}});
      return {runId:marker};
    }
    if(method==='agent.wait')return {status:'ok'};
    if(method==='plugin.approval.resolve'){
      if(args.decision==='allow-once')current.control={...current.control,textLength:10,textSha256:sha('owned-test'),keyCount:10};return {};
    }
    throw Error('Unexpected fixture RPC');
  };
  return {context,change(fn){fn(current);}};
}
test('verified post-allow state remains authoritative through observation and denial',async()=>{
  const h=harness(),c=h.context;
  const allowed=await runProviderCase('allowed',{},c);assert.equal(allowed.effect.charactersAdded,10);assert.equal(c.expectedObservation.control.textSha256,sha('owned-test'));
  const after=await runProviderCase('allowed-after',{captureOnly:true},c);assert.equal(after.effect.charactersAdded,0);
  const denied=await runProviderCase('forged-confirm-denied',{denied:true,format:'jpg'},c);assert.equal(denied.effect.charactersAdded,0);
  await runProviderCase('denied-after',{captureOnly:true,format:'jpg'},c);assert.equal(c.expectedObservation.control.keyCount,10);assert.equal(c.expectedObservation.control.scrollOffset,0);
});
for(const variant of ['text','key','scroll','identity'])test(`rejects ${variant} introduced specifically between completed cases`,async()=>{
  const h=harness(),c=h.context;await runProviderCase('allowed',{},c);
  h.change(value=>{
    if(variant==='text'){value.control.textLength++;value.control.textSha256=sha('owned-testx');}
    if(variant==='key')value.control.keyCount++;
    if(variant==='scroll')value.control.scrollOffset=7;
    if(variant==='identity')value.control.fixtureIdentity='e'.repeat(64);
  });
  await assert.rejects(runProviderCase('allowed-after',{captureOnly:true},c),/WAYLAND_PROVIDER_LEASE_REJECTED/);
  assert.equal(c.expectedObservation.control.textSha256,sha('owned-test'));assert.equal(c.expectedObservation.control.keyCount,10);assert.equal(c.expectedObservation.control.scrollOffset,0);
});
