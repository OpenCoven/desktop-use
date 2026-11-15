import assert from 'node:assert/strict';
import { proveImageFormat } from './linux-scope-proof.mjs';

function rectangle(r) {
  assert.ok(r && ['x','y','width','height'].every(k=>Number.isSafeInteger(r[k])));
  assert.ok(r.width>0 && r.height>0);
  return r;
}

export function normalizeWaylandSnapshot({version,outputs,tree,fixturePid,fixtureTitle}) {
  assert.ok(version?.variant==='sway' && version.major===1 && version.minor===7 && version.patch===0 && version.human_readable==='1.7','only the source-bound Sway1.7 layout is admitted');
  assert.ok(Array.isArray(outputs) && outputs.length===1,'one owned headless output required');
  const o=outputs[0];assert.ok(o.active===true && o.name==='HEADLESS-1' && o.make==='headless' && o.model==='headless');
  const rect=rectangle(o.rect);assert.ok([1,2].includes(o.scale) && o.transform==='normal');
  const physicalSize={width:rect.width*o.scale,height:rect.height*o.scale};
  assert.equal(o.current_mode?.width,physicalSize.width);assert.equal(o.current_mode?.height,physicalSize.height);
  assert.ok(Number.isSafeInteger(fixturePid) && fixturePid>1 && typeof fixtureTitle==='string' && fixtureTitle.length>0);
  const matches=[];
  function visit(node) {
    assert.ok(node && typeof node==='object');
    if(node.pid===fixturePid)matches.push(node);
    for(const child of [...(node.nodes??[]),...(node.floating_nodes??[])])visit(child);
  }
  visit(tree);assert.equal(matches.length,1,'exactly one owned fixture window required');
  const window=matches[0];assert.equal(window.name,fixtureTitle);assert.equal(window.focused,true);
  assert.ok(Number.isSafeInteger(window.id) && window.id>1);rectangle(window.rect);
  assert.ok(window.rect.x>=rect.x && window.rect.y>=rect.y && window.rect.x+window.rect.width<=rect.x+rect.width && window.rect.y+window.rect.height<=rect.y+rect.height);
  return {windowId:window.id,windowRect:window.rect,focused:true,output:{name:o.name,rect,physicalSize,scale:o.scale,transform:o.transform}};
}

// This pure verifier never starts a compositor, captures pixels or sends input.
export function proveWaylandCapture({before,after,receipt,fixture,format,imageMimeType,decodedDimensions,decodedMimeType}) {
  for(const snapshot of [before,after]) {
    for(const key of ['fixturePid','compositorPid','windowId']) assert.ok(Number.isSafeInteger(snapshot[key]) && snapshot[key]>1);
    for(const key of ['fixtureStartTicks','compositorStartTicks']) assert.match(snapshot[key],/^[1-9]\d*$/);
    assert.equal(snapshot.focused,true);
    rectangle(snapshot.windowRect);rectangle(snapshot.output.rect);
    assert.equal(snapshot.output.name,'HEADLESS-1');
    assert.equal(snapshot.output.transform,'normal');
    assert.ok([1,2].includes(snapshot.output.scale),'only scale1/scale2 are admitted; native qualification remains separate');
    assert.deepEqual(snapshot.output.physicalSize,{width:snapshot.output.rect.width*snapshot.output.scale,height:snapshot.output.rect.height*snapshot.output.scale});
    assert.ok(Number.isSafeInteger(snapshot.startedAtMs) && Number.isSafeInteger(snapshot.finishedAtMs) && snapshot.finishedAtMs>=snapshot.startedAtMs);
    assert.ok(Number.isFinite(snapshot.startedMonotonicMs) && Number.isFinite(snapshot.finishedMonotonicMs) && snapshot.finishedMonotonicMs>=snapshot.startedMonotonicMs);
  }
  for(const key of ['fixturePid','fixtureStartTicks','compositorPid','compositorStartTicks','windowId','windowRect','output']) assert.deepEqual(after[key],before[key],`owned Wayland ${key} changed across capture`);
  assert.equal(fixture.pid,before.fixturePid);
  assert.deepEqual(fixture.origin,[before.windowRect.x,before.windowRect.y]);
  assert.deepEqual(fixture.size,[before.windowRect.width,before.windowRect.height]);
  assert.ok(before.finishedMonotonicMs<=after.startedMonotonicMs && after.finishedMonotonicMs-before.startedMonotonicMs<=20_000,'monotonic capture bracket is reversed or expired');
  assert.ok(before.finishedAtMs<=receipt.capturedAtMs && receipt.capturedAtMs<=after.startedAtMs,'capture epoch timestamp must lie inside the independent bracket');
  const output=before.output, dimensions=output.physicalSize;
  assert.equal(receipt.requestedScope.mode,'screen');
  assert.equal(receipt.actualScope.state,'available');assert.equal(receipt.actualScope.mode,'screen');
  assert.equal(receipt.geometry.state,'available');assert.equal(receipt.geometry.coordinateUnits,'desktop-logical-pixels');
  assert.deepEqual(receipt.geometry.regions,[{displayId:output.name,imageRect:{x:0,y:0,...dimensions},desktopRect:output.rect}]);
  assert.deepEqual(decodedDimensions,dimensions,'actual decoded pixels must match the independent physical output size');
  assert.deepEqual(receipt.primaryImage.sourceDimensions,dimensions);assert.deepEqual(receipt.primaryImage.deliveredDimensions,dimensions);
  const formatProof=proveImageFormat({requestedFormat:format,imageMimeType,receiptMimeType:receipt.primaryImage.mimeType,decodedMimeType});
  return {scale:output.scale,desktopRect:output.rect,physicalDimensions:dimensions,windowRect:before.windowRect,fixturePid:before.fixturePid,compositorPid:before.compositorPid,independentExtentVerified:true,formatProof,bracketDurationMs:after.finishedMonotonicMs-before.startedMonotonicMs};
}
