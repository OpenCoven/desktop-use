import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFixtureLease } from './fixture-lease.mjs';
function sample() {
  const baseline = { ready: true, pid: 42, windowNumber: 7, clicks: 0, desktopRect: { x: -100, y: 20, width: 640, height: 480 }, windowFrameRect: { x: -100, y: -12, width: 640, height: 512 }, backingScale: 2, targetRect: [40,40,120,80] };
  const descriptor = { platform:'darwin',fixturePid:42,fixtureWindowId:7,adapterSha256:'a',packageSha256:'b',sourceCommit:'c',fixtureLease:{ acknowledgement:'native-openclaw-fixture-exclusive',ownerThread:'owner',expiresAt:new Date(Date.now()+60_000).toISOString(),fixturePid:42,fixtureWindowId:7,adapterSha256:'a',packageSha256:'b',sourceCommit:'c' } };
  return { baseline, current: structuredClone(baseline), descriptor };
}
test('a current unchanged fixture lease can permit the explicitly bound request', () => { const s=sample(); assert.doesNotThrow(()=>assertFixtureLease(s.descriptor,s.current,s.baseline)); });
for (const variant of ['expired','changed-window','moved-target','counter-changed','changed-frame','changed-backing-scale','missing-independent-frame']) test(`rejects before approval: ${variant}`,()=>{
  const s=sample();
  if(variant==='expired')s.descriptor.fixtureLease.expiresAt=new Date(Date.now()-1).toISOString();
  if(variant==='changed-window')s.current.windowNumber++;
  if(variant==='moved-target')s.current.desktopRect.x++;
  if(variant==='counter-changed')s.current.clicks++;
  if(variant==='changed-frame')s.current.windowFrameRect.width++;
  if(variant==='changed-backing-scale')s.current.backingScale=1;
  if(variant==='missing-independent-frame'){delete s.current.windowFrameRect;delete s.baseline.windowFrameRect;}
  assert.throws(()=>assertFixtureLease(s.descriptor,s.current,s.baseline));
});
