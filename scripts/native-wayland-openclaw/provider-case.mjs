import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {providerToolCallId,assertProviderLease} from './run-contract.mjs';
import {proveTextEffect,proveNoEffect} from './effect-proof.mjs';

export async function runProviderCase(marker, { denied = false, captureOnly = false, format = 'png' } = {}, context) {
    const {control,fixture,plans,events,rpc,activeRuns,descriptor,plannedText,until,delay,session}=context;
    control.check();
    const before = await fixture();
    assert.ok(context.expectedObservation, 'Known preceding fixture state required');
    assertProviderLease(descriptor,before,context.expectedObservation);
    plans.set(marker, { before, denied, captureOnly, format, responses: 0, nextResultCount:0 }); const eventStart = events.length;
    context.setPhase('agent-start');
    const accepted = await rpc('agent', { message: `WAYLAND21_CASE:${marker}`, agentId: 'computer-use', sessionKey: session, idempotencyKey: randomUUID(), deliver: false, timeout: 180 });
    activeRuns.add(accepted.runId);
    const completed = rpc('agent.wait', { runId: accepted.runId, timeoutMs: 180_000 }); completed.catch(() => {});
    if (!captureOnly) {
      context.setPhase('approval-request');
      const approval = await until(() => {
        context.assertHealthy();
        return events.slice(eventStart).find(event => event.event === 'plugin.approval.requested' && event.payload.request.toolCallId === providerToolCallId(marker, 'type'));
      });
      assertProviderLease(descriptor,fixture(),before);
      control.check();
      await rpc('plugin.approval.resolve', { id: approval.payload.id, decision: denied ? 'deny' : 'allow-once' });
      context.approvals.push({ marker, toolCallId: providerToolCallId(marker, 'type'), decision: denied ? 'deny' : 'allow-once', actualHostApproval: true });
    }
    context.setPhase('agent-completion');
    const outcome = await completed; activeRuns.delete(accepted.runId);
    assert.equal(outcome.status,'ok'); context.assertHealthy();
    let after, effect;
    if (!captureOnly && !denied) {
      after = await until(() => {
        const current = fixture(), value = current.control, prior = before.control;
        assert.equal(value.fixtureIdentity,prior.fixtureIdentity); assert.equal(value.clickCount,prior.clickCount); assert.equal(value.scrollOffset,prior.scrollOffset);
        assert.ok(value.textLength<=plannedText.length && value.keyCount<=plannedText.length);
        if(value.textLength!==plannedText.length || value.keyCount!==plannedText.length)return false;
        effect=proveTextEffect({before:prior,after:value,text:plannedText,decision:'allow'}); return current;
      },5_000);
    } else {
      const end = Date.now()+250;
      do { after=fixture(); effect=proveNoEffect({before:before.control,after:after.control,decision:denied?'deny':'capture-only'}); await delay(25); } while(Date.now()<end);
      after=fixture(); effect=proveNoEffect({before:before.control,after:after.control,decision:denied?'deny':'capture-only'});
    }
    assert.equal(plans.get(marker).responses,captureOnly?2:3);
    assert.equal(plans.get(marker).nextResultCount,null);
    context.expectedObservation=after;
    return ({marker,denied,captureOnly,format,effect,actualProviderResponses:plans.get(marker).responses,noEffectObservationMs:captureOnly||denied?250:undefined});
  }

// Exercise JPEG before any input while preserving all four original qualification cases.
export async function runProviderCases(context,record) {
  for(const [marker,options] of [['jpeg-before-input',{captureOnly:true,format:'jpg'}],['allowed',{}],['allowed-after',{captureOnly:true}],['forged-confirm-denied',{denied:true,format:'jpg'}],['denied-after',{captureOnly:true,format:'jpg'}]])record(await runProviderCase(marker,options,context));
}
