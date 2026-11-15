import assert from 'node:assert/strict';
import { openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { captureOwnedWaylandSnapshot } from './wayland-owned-snapshot.mjs';

const sourceSha256 = 'a1325e42991551ba7a5ed8581d2ec5fe324e548b4f687bb3f605cca3a1a74952';
const hash = value => createHash('sha256').update(value).digest('hex');
const colors = new Map([['NW', [40,210,220]], ['NE', [200,60,210]], ['SW', [250,145,30]], ['SE', [225,235,250]]]);
const rect = value => {
  assert.ok(value && ['x','y','width','height'].every(k => Number.isSafeInteger(value[k])) && value.width > 0 && value.height > 0);
  return Object.fromEntries(['x','y','width','height'].map(k => [k, value[k]]));
};
function geometry(value) {
  for (const k of ['fixturePid','compositorPid','windowId']) assert.ok(Number.isSafeInteger(value[k]) && value[k] > 1);
  for (const k of ['fixtureStartTicks','compositorStartTicks']) assert.match(value[k], /^[1-9]\d*$/);
  assert.equal(value.focused, true);
  assert.equal(value.metadataWorker?.reaped, true); assert.equal(value.metadataWorker?.status, 0);
  const windowRect = rect(value.windowRect), outputRect = rect(value.output.rect);
  assert.equal(value.output.name, 'HEADLESS-1'); assert.equal(value.output.transform, 'normal');
  assert.ok([1,2].includes(value.output.scale));
  const physicalSize = { width: outputRect.width * value.output.scale, height: outputRect.height * value.output.scale };
  assert.deepEqual(value.output.physicalSize, physicalSize);
  assert.ok(windowRect.x >= outputRect.x && windowRect.y >= outputRect.y && windowRect.x + windowRect.width <= outputRect.x + outputRect.width && windowRect.y + windowRect.height <= outputRect.y + outputRect.height);
  return { fixturePid: value.fixturePid, fixtureStartTicks: value.fixtureStartTicks, compositorPid: value.compositorPid, compositorStartTicks: value.compositorStartTicks, windowId: value.windowId, windowRect, output: { name: 'HEADLESS-1', rect: outputRect, physicalSize, scale: value.output.scale, transform: 'normal' } };
}

// The file is observed between live identity/geometry probes. A file read is
// not a GUI completion fence, and these summaries never confer approval.
export function readOwnedFixture(config, { capture = captureOwnedWaylandSnapshot, uid = process.getuid?.() } = {}) {
  try {
    assert.ok(Number.isSafeInteger(uid) && uid > 0 && isAbsolute(config.fixtureStatePath));
    assert.equal(config.fixtureSourceSha256, sourceSha256, 'Known fixture layout required');
    const before = capture(config), start = geometry(before);
    for (const k of ['fixturePid','fixtureStartTicks','compositorPid','compositorStartTicks']) assert.equal(start[k], config[k]);
    const fd = openSync(config.fixtureStatePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw;
    try {
      const info = fstatSync(fd); assert.ok(info.isFile() && info.uid === uid && info.size <= 1024 * 1024);
      const data = Buffer.alloc(1024 * 1024 + 1); let total = 0, count;
      while (total < data.length && (count = readSync(fd, data, total, data.length - total, null)) > 0) total += count;
      assert.ok(total <= 1024 * 1024 && total === info.size);
      const end = fstatSync(fd); assert.ok(end.size === info.size && end.mtimeMs === info.mtimeMs);
      raw = JSON.parse(data.subarray(0, total).toString('utf8'));
    } finally { closeSync(fd); }
    const after = capture(config), finish = geometry(after); assert.deepEqual(finish, start);
    for (const value of [before, after]) {
      assert.ok(Number.isSafeInteger(value.startedAtMs) && Number.isSafeInteger(value.finishedAtMs) && value.finishedAtMs >= value.startedAtMs);
      assert.ok(Number.isFinite(value.startedMonotonicMs) && Number.isFinite(value.finishedMonotonicMs) && value.finishedMonotonicMs >= value.startedMonotonicMs);
    }
    assert.ok(before.finishedMonotonicMs <= after.startedMonotonicMs && after.finishedMonotonicMs - before.startedMonotonicMs <= 10_000 && before.finishedAtMs <= after.startedAtMs);
    assert.equal(raw.ready, true); assert.equal(raw.pid, config.fixturePid); assert.equal(raw.entryFocused, true);
    assert.deepEqual(raw.size, [finish.windowRect.width, finish.windowRect.height]);
    assert.ok(typeof raw.text === 'string' && Array.isArray(raw.keys) && Array.isArray(raw.clicks) && raw.keys.length <= 1_000_000 && raw.clicks.length <= 1_000_000);
    assert.ok(Number.isFinite(raw.scrollOffset) && raw.scrollOffset >= 0 && raw.scrollOffset <= 1_000_000);
    function box(value) {
      assert.ok(Array.isArray(value) && value.length === 4 && value.every(Number.isSafeInteger));
      const [x,y,w,h] = value; assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x+w <= raw.size[0] && y+h <= raw.size[1]); return [...value];
    }
    assert.ok(Array.isArray(raw.landmarks) && raw.landmarks.length === 4 && new Set(raw.landmarks.map(v => v.name)).size === 4);
    const landmarks = raw.landmarks.map(v => { assert.ok(colors.has(v.name)); assert.deepEqual(v.rgb, colors.get(v.name)); return { name: v.name, rect: box(v.rect), rgb: [...colors.get(v.name)] }; });
    const control = { fixtureIdentity: hash(JSON.stringify({ ...finish, sourceSha256 })), entryFocused: true, textLength: [...raw.text].length, textSha256: hash(raw.text), keyCount: raw.keys.length, clickCount: raw.clicks.length, scrollOffset: raw.scrollOffset };
    const fixture = { ready: true, pid: raw.pid, windowNumber: finish.windowId, origin: [finish.windowRect.x, finish.windowRect.y], size: [...raw.size], targetRect: [20,20,120,80], clickCount: raw.clicks.length, landmarks, controls: { textEntry: box(raw.controls.textEntry), scrollRegion: box(raw.controls.scrollRegion) } };
    const snapshot = { ...finish, focused: true, startedAtMs: after.startedAtMs, finishedAtMs: after.finishedAtMs, startedMonotonicMs: after.startedMonotonicMs, finishedMonotonicMs: after.finishedMonotonicMs };
    return { fixture, control, snapshot };
  } catch {
    const error = new Error('WAYLAND_FIXTURE_OBSERVATION_REJECTED'); error.code = 'WAYLAND_FIXTURE_OBSERVATION_REJECTED'; throw error;
  }
}
