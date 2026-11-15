import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { proveNoEffect } from './effect-proof.mjs';

// Both trusted descriptor and lease must agree with the explicit CLI selection.
// Missing flags preserve the original full workflow, never opt into observation.
export function assertProviderWorkflowMode(descriptor,observationOnly) {
  if(typeof observationOnly!=='boolean'||!descriptor?.fixtureLease||
    (descriptor.observationOnly===undefined?false:descriptor.observationOnly)!==observationOnly||
    (descriptor.fixtureLease.observationOnly===undefined?false:descriptor.fixtureLease.observationOnly)!==observationOnly)throw new Error('WAYLAND_PROVIDER_MODE_REJECTED');
  return true;
}

export function assertProviderWorkflowStep(observationOnly,plan,step) {
  if(typeof observationOnly!=='boolean'||(observationOnly&&(plan?.captureOnly!==true||!['capture','complete'].includes(step))))throw new Error('WAYLAND_PROVIDER_MODE_REJECTED');
  return true;
}

export function providerToolCallId(marker, action) {
  assert.match(marker, /^[a-z0-9-]{1,24}$/);
  assert.ok(action === 'capture' || action === 'type');
  return `wl21${createHash('sha256').update(marker).digest('hex').slice(0,24)}${action}`;
}

export function assertProviderLease(descriptor, observed, baseline = observed, { now = Date.now } = {}) {
  try {
    const lease = descriptor.fixtureLease, config = descriptor.wayland;
    assert.equal(lease?.acknowledgement, 'native-openclaw-fixture-exclusive');
    assert.ok(typeof lease.ownerThread === 'string' && lease.ownerThread.length > 0 && lease.ownerThread.length <= 128);
    assert.match(lease.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/);
    const expires = Date.parse(lease.expiresAt), at = now();
    assert.ok(expires > at && expires < at + 3_600_000);
    for (const key of ['fixturePid','fixtureWindowId','adapterSha256','packageSha256','sourceCommit']) assert.equal(lease[key], descriptor[key]);
    for (const key of ['fixturePid','fixtureStartTicks','compositorPid','compositorStartTicks']) {
      assert.equal(lease[key], config[key]); assert.equal(observed.snapshot[key], config[key]);
    }
    assert.equal(config.fixturePid, descriptor.fixturePid);
    assert.equal(observed.fixture.ready, true); assert.equal(observed.fixture.pid, descriptor.fixturePid);
    assert.equal(observed.fixture.windowNumber, descriptor.fixtureWindowId); assert.equal(observed.snapshot.windowId, descriptor.fixtureWindowId);
    assert.ok([1,2].includes(config.scale)); assert.equal(lease.scale, config.scale); assert.equal(observed.snapshot.output.scale, config.scale);
    proveNoEffect({ before: baseline.control, after: observed.control, decision: 'capture-only' });
    return true;
  } catch {
    const error = new Error('WAYLAND_PROVIDER_LEASE_REJECTED'); error.code = 'WAYLAND_PROVIDER_LEASE_REJECTED'; throw error;
  }
}

// Consume each step before sending its response. A transport retry fails rather
// than emitting another capture/input, even if the previous response was lost.
export function acceptProviderStep(plan, resultCount) {
  try {
    assert.ok(typeof plan.captureOnly === 'boolean' && Number.isSafeInteger(resultCount) && resultCount >= 0 && resultCount <= 2);
    assert.notEqual(plan.nextResultCount, null); assert.equal(resultCount, plan.nextResultCount);
    const last = plan.captureOnly ? 1 : 2;
    assert.ok(resultCount <= last); plan.nextResultCount = resultCount === last ? null : resultCount + 1;
    return resultCount === 0 ? 'capture' : resultCount === last ? 'complete' : 'input';
  } catch {
    const error = new Error('WAYLAND_PROVIDER_SEQUENCE_REJECTED'); error.code = 'WAYLAND_PROVIDER_SEQUENCE_REJECTED'; throw error;
  }
}

// The exact helper search path was already selected and hash-bound by the operator.
// Tell the unchanged official host not to prepend system tools over that selection.
export function providerGatewayHelperEnvironment(search) {
  if(typeof search!=='string' || search.length>4096 || /[\x00-\x20\x7f]/.test(search) || !search.split(':').every(part=>part.startsWith('/')&&!part.split('/').includes('..')))throw new Error('WAYLAND_PROVIDER_HELPER_PATH_REJECTED');
  return {PATH:search,OPENCLAW_PATH_BOOTSTRAPPED:'1'};
}

export function classifyDiagnosticPrivacy(text,privateText) {
  if(typeof text!=='string'||typeof privateText!=='string'||privateText.length<1||privateText.length>128)return 'invalid-diagnostic-input';
  if(/data:image\/(png|jpeg);base64,/.test(text))return 'image-data';
  if(/"screenshot_raw"/.test(text))return 'raw-screenshot-field';
  if(text.includes(privateText))return 'private-text';
  return 'safe';
}
export async function checkDiagnosticPrivacy(read,privateText) {
  const checks=[];
  for(const kind of ['console','gateway']) {
    try {checks.push({kind,reason:classifyDiagnosticPrivacy(await read(kind),privateText)});}
    catch(error) {checks.push(error?.code==='ENOENT'?{kind,reason:'absent'}:{kind,reason:'read-failure',readCode:['EACCES','EPERM','EIO','EISDIR','EMFILE'].includes(error?.code)?error.code:'WITHHELD'});}
  }
  return {safe:checks.every(row=>row.reason==='safe'||row.reason==='absent'),checks};
}
