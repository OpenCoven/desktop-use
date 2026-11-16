import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { focusedFixture, nativeHarnessEnvironment } from './identity-preflight.mjs';

export function proveImageFormat({requestedFormat,imageMimeType,receiptMimeType,decodedMimeType}) {
  assert.ok(['png','jpg'].includes(requestedFormat));
  const expected=requestedFormat==='png'?'image/png':'image/jpeg';
  for(const mime of [imageMimeType,receiptMimeType,decodedMimeType]) assert.equal(mime,expected,'requested format must match wire metadata and decoded bytes');
  return {requestedFormat,imageMimeType,receiptMimeType,decodedMimeType};
}

export function parseX11Rectangle(text, expectedWindowId) {
  const ids = [...text.matchAll(/^xwininfo: Window id: (0x[0-9a-f]+)\b.*$/gim)];
  assert.equal(ids.length, 1, 'one independent X11 window identity required');
  const id = Number(ids[0][1]);
  assert.ok(Number.isSafeInteger(id) && id > 0);
  if (expectedWindowId !== undefined) assert.equal(id, expectedWindowId, 'X11 window identity changed');
  else assert.ok(ids[0][0].includes('(the root window)'), 'root geometry must identify the root window');
  function field(label) {
    const values = text.split('\n').map(line=>line.trim()).filter(line=>line.startsWith(`${label}:`));
    assert.equal(values.length, 1, `one ${label} required`);
    const value = values[0].slice(label.length+1).trim();
    assert.match(value, /^-?\d+$/);
    const number = Number(value); assert.ok(Number.isSafeInteger(number)); return number;
  }
  assert.equal(field('Border width'), 0, 'border-inclusive captures are not qualified');
  assert.equal(text.split('\n').filter(line=>line.trim()==='Map State: IsViewable').length, 1);
  const rect = {x:field('Absolute upper-left X'),y:field('Absolute upper-left Y'),width:field('Width'),height:field('Height')};
  assert.ok(rect.width > 0 && rect.height > 0);
  if (expectedWindowId === undefined) assert.deepEqual([rect.x,rect.y],[0,0]);
  return rect;
}

export function proveCaptureScope({mode,before,after,receipt,fixture,decodedDimensions}) {
  assert.ok(['screen','frontmost'].includes(mode));
  for (const snapshot of [before,after]) {
    assert.ok(Number.isSafeInteger(snapshot.pid) && snapshot.pid > 1);
    assert.match(snapshot.processStartTicks,/^[1-9]\d*$/);
    assert.ok(Number.isSafeInteger(snapshot.windowId) && snapshot.windowId > 0);
    assert.ok(Number.isSafeInteger(snapshot.startedAtMs) && Number.isSafeInteger(snapshot.finishedAtMs) && snapshot.finishedAtMs >= snapshot.startedAtMs);
    assert.ok(Number.isFinite(snapshot.startedMonotonicMs) && Number.isFinite(snapshot.finishedMonotonicMs) && snapshot.finishedMonotonicMs >= snapshot.startedMonotonicMs);
  }
  for (const key of ['pid','processStartTicks','windowId','window','root']) assert.deepEqual(after[key],before[key], `independent ${key} changed across capture`);
  assert.equal(fixture.pid,before.pid);
  assert.deepEqual(fixture.origin,[before.window.x,before.window.y]);
  assert.deepEqual(fixture.size,[before.window.width,before.window.height]);
  assert.ok(before.finishedAtMs <= receipt.capturedAtMs && receipt.capturedAtMs <= after.startedAtMs, 'capture timestamp must lie inside independent bracket');
  assert.ok(before.finishedMonotonicMs <= after.startedMonotonicMs, 'independent monotonic bracket reversed');
  assert.ok(after.finishedMonotonicMs-before.startedMonotonicMs <= 20_000, 'independent monotonic capture bracket expired');
  assert.ok(after.finishedAtMs-before.startedAtMs <= 20_000, 'independent capture bracket expired');
  assert.equal(receipt.requestedScope.mode,mode);
  assert.equal(receipt.actualScope.state,'available'); assert.equal(receipt.actualScope.mode,mode);
  assert.equal(receipt.geometry.state,'available');
  assert.equal(receipt.geometry.coordinateUnits,'desktop-physical-pixels');
  const expected = mode === 'screen' ? before.root : before.window;
  const dimensions = {width:expected.width,height:expected.height};
  assert.deepEqual(decodedDimensions,dimensions, 'decoded pixels must have the exact requested independent extent');
  assert.deepEqual(receipt.primaryImage.sourceDimensions,dimensions);
  assert.deepEqual(receipt.primaryImage.deliveredDimensions,dimensions);
  assert.deepEqual(receipt.geometry.regions,[{imageRect:{x:0,y:0,...dimensions},desktopRect:expected}], 'capture mapping must cover exactly the requested rectangle');
  return {requestedMode:mode,independentExtentVerified:true,desktopRect:expected,decodedDimensions,windowRect:before.window,displayRect:before.root,physicalPixelScale:1,windowId:before.windowId,fixturePid:before.pid,processStartTicks:before.processStartTicks,capturedAtMs:receipt.capturedAtMs,beforeProbe:{startedAtMs:before.startedAtMs,finishedAtMs:before.finishedAtMs,startedMonotonicMs:before.startedMonotonicMs,finishedMonotonicMs:before.finishedMonotonicMs},afterProbe:{startedAtMs:after.startedAtMs,finishedAtMs:after.finishedAtMs,startedMonotonicMs:after.startedMonotonicMs,finishedMonotonicMs:after.finishedMonotonicMs},bracketDurationMs:after.finishedMonotonicMs-before.startedMonotonicMs,wallBracketDurationMs:after.finishedAtMs-before.startedAtMs};
}

// Read only the explicitly owned disposable session. No focus/input commands.
export async function captureX11ScopeSnapshot(statePath, {platform=process.platform,now=Date.now,monotonicNow=()=>performance.now(),read=readFile,focused=focusedFixture,environment=nativeHarnessEnvironment,execute=spawnSync}={}) {
  assert.equal(platform,'linux');
  const startedAtMs=now(), startedMonotonicMs=monotonicNow(), end=startedMonotonicMs+4_000;
  const fixture=await focused(statePath);
  const env=environment(dirname(statePath));
  const run=(program,args)=>{
    assert.ok(monotonicNow()<end,'independent geometry deadline expired');
    const r=execute(program,args,{env,encoding:'utf8',timeout:Math.min(4000,Math.max(1,Math.ceil(end-monotonicNow()))),maxBuffer:32_768});
    assert.equal(r.status,0,`independent ${program} probe failed`); return r.stdout.trim();
  };
  const processBirth=async()=>{
    const stat=await read(`/proc/${fixture.pid}/stat`,'utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    assert.ok(!['Z','X'].includes(fields[0]),'fixture is not a live process');
    assert.match(fields[19],/^[1-9]\d*$/);return fields[19];
  };
  const processStartTicks=await processBirth();
  const active=()=>{const s=run('xdotool',['getactivewindow']);assert.match(s,/^[1-9]\d*$/);return Number(s);};
  const windowId=active();
  const windowPid=()=>{const s=run('xdotool',['getwindowpid',String(windowId)]);assert.match(s,/^[1-9]\d*$/);assert.equal(Number(s),fixture.pid);};
  windowPid();
  const window=parseX11Rectangle(run('xwininfo',['-id',String(windowId)]),windowId);
  const root=parseX11Rectangle(run('xwininfo',['-root']));
  windowPid();assert.equal(active(),windowId);assert.equal(await processBirth(),processStartTicks);
  assert.deepEqual(fixture.origin,[window.x,window.y]);assert.deepEqual(fixture.size,[window.width,window.height]);
  const finishedMonotonicMs=monotonicNow(), finishedAtMs=now();
  assert.ok(finishedMonotonicMs<=end,'independent geometry deadline expired');
  assert.ok(finishedAtMs>=startedAtMs,'wall clock rolled backward during geometry acquisition');
  return {pid:fixture.pid,processStartTicks,windowId,window,root,startedAtMs,finishedAtMs,startedMonotonicMs,finishedMonotonicMs};
}
