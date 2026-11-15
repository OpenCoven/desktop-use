import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readOwnedFixture } from './fixture-observation.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function sample(t) {
  const root = mkdtempSync(join(tmpdir(), 'wayland-controls-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { fixtureStatePath: join(root, 'state.json'), fixturePid: 123, fixtureStartTicks: '111', compositorPid: 456, compositorStartTicks: '222', fixtureSourceSha256: 'a1325e42991551ba7a5ed8581d2ec5fe324e548b4f687bb3f605cca3a1a74952' };
  const raw = { ready: true, pid: 123, entryFocused: true, text: 'fixture-secret', keys: [{ name: 't' }], clicks: [], scrollOffset: 0, size: [640, 480], controls: { textEntry: [170, 100, 430, 34], scrollRegion: [170, 180, 430, 230] }, landmarks: [
    { name: 'NW', rect: [4, 4, 16, 16], rgb: [40, 210, 220] }, { name: 'NE', rect: [620, 4, 16, 16], rgb: [200, 60, 210] },
    { name: 'SW', rect: [4, 448, 16, 16], rgb: [250, 145, 30] }, { name: 'SE', rect: [620, 448, 16, 16], rgb: [225, 235, 250] },
  ], arbitraryPrivate: 'never-return-this' };
  const before = { fixturePid: 123, fixtureStartTicks: '111', compositorPid: 456, compositorStartTicks: '222', windowId: 5, windowRect: { x: -100, y: 20, width: 640, height: 480 }, focused: true, output: { name: 'HEADLESS-1', rect: { x: -100, y: 20, width: 640, height: 480 }, physicalSize: { width: 1280, height: 960 }, scale: 2, transform: 'normal' }, startedAtMs: 1000, finishedAtMs: 1010, startedMonotonicMs: 10, finishedMonotonicMs: 20, metadataWorker: { pid: 600, reaped: true, status: 0 } };
  const after = { ...structuredClone(before), startedAtMs: 1011, finishedAtMs: 1020, startedMonotonicMs: 21, finishedMonotonicMs: 30 };
  let call = 0;
  const options = { capture: () => structuredClone(call++ === 0 ? before : after) };
  const save = () => writeFileSync(config.fixtureStatePath, JSON.stringify(raw), { mode: 0o600 });
  save(); return { config, raw, before, after, options, save, root };
}

test('real fixture file produces only bound geometry, counts and hashes', t => {
  const s = sample(t), result = readOwnedFixture(s.config, s.options);
  assert.ok(result, 'A bound fixture observation is required');
  assert.deepEqual(result.control, { fixtureIdentity: result.control.fixtureIdentity, entryFocused: true, textLength: 14, textSha256: sha('fixture-secret'), keyCount: 1, clickCount: 0, scrollOffset: 0 });
  assert.match(result.control.fixtureIdentity, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.fixture.origin, [-100, 20]);
  assert.deepEqual(result.fixture.targetRect, [20, 20, 120, 80]);
  assert.deepEqual(result.fixture.controls.textEntry, [170, 100, 430, 34]);
  assert.equal(result.snapshot.output.scale, 2);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(result).includes('never-return-this'), false);
  assert.equal(Object.hasOwn(result, 'nativeExecuted'), false);
});

test('fixture character count agrees with Unicode code points without returning text', t => {
  const s = sample(t); s.raw.text = 'A💡'; s.save();
  const result = readOwnedFixture(s.config, s.options); assert.ok(result);
  assert.equal(result.control.textLength, 2); assert.equal(result.control.textSha256, sha('A💡'));
});

for (const variant of ['not-ready', 'wrong-pid', 'lost-entry-focus', 'wrong-size', 'bad-keys', 'bad-clicks', 'bad-text', 'bad-scroll', 'duplicate-landmark', 'wrong-landmark-color', 'outside-control', 'different-source']) test(`fixture observation rejects ${variant}`, t => {
  const s = sample(t);
  if (variant === 'not-ready') s.raw.ready = false;
  if (variant === 'wrong-pid') s.raw.pid++;
  if (variant === 'lost-entry-focus') s.raw.entryFocused = false;
  if (variant === 'wrong-size') s.raw.size[0]++;
  if (variant === 'bad-keys') s.raw.keys = 'private-key-value';
  if (variant === 'bad-clicks') s.raw.clicks = {};
  if (variant === 'bad-text') s.raw.text = {};
  if (variant === 'bad-scroll') s.raw.scrollOffset = -1;
  if (variant === 'duplicate-landmark') s.raw.landmarks[1] = structuredClone(s.raw.landmarks[0]);
  if (variant === 'wrong-landmark-color') s.raw.landmarks[0].rgb = [0, 0, 0];
  if (variant === 'outside-control') s.raw.controls.textEntry = [630, 100, 430, 34];
  if (variant === 'different-source') s.config.fixtureSourceSha256 = '0'.repeat(64);
  s.save(); assert.throws(() => readOwnedFixture(s.config, s.options), /WAYLAND_FIXTURE_OBSERVATION_REJECTED/);
});

for (const variant of ['changed-window', 'changed-birth', 'wrong-selected-pid', 'lost-focus', 'expired-bracket', 'clock-reversed', 'unreaped-worker']) test(`fixture observation rejects independent bracket ${variant}`, t => {
  const s = sample(t);
  if (variant === 'changed-window') s.after.windowRect.x++;
  if (variant === 'changed-birth') s.after.fixtureStartTicks = '112';
  if (variant === 'wrong-selected-pid') s.config.fixturePid = 999;
  if (variant === 'lost-focus') s.after.focused = false;
  if (variant === 'expired-bracket') s.after.finishedMonotonicMs = 10011;
  if (variant === 'clock-reversed') s.after.startedMonotonicMs = 1;
  if (variant === 'unreaped-worker') s.after.metadataWorker.reaped = false;
  assert.throws(() => readOwnedFixture(s.config, s.options), /WAYLAND_FIXTURE_OBSERVATION_REJECTED/);
});

test('fixture path symlinks and oversized files cannot become control evidence', t => {
  const s = sample(t); const link = join(s.root, 'link.json'); symlinkSync(s.config.fixtureStatePath, link);
  assert.throws(() => readOwnedFixture({ ...s.config, fixtureStatePath: link }, s.options), /WAYLAND_FIXTURE_OBSERVATION_REJECTED/);
  writeFileSync(s.config.fixtureStatePath, 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => readOwnedFixture(s.config, { capture: () => structuredClone(s.before) }), /WAYLAND_FIXTURE_OBSERVATION_REJECTED/);
});

test('collector and JSON failures never echo private input or paths', t => {
  const s = sample(t);
  for (const options of [s.options, { capture: () => { throw new Error('private-fixture-path-and-payload'); } }]) {
    writeFileSync(s.config.fixtureStatePath, '{private-fixture-path-and-payload');
    assert.throws(() => readOwnedFixture(s.config, options), error => {
      assert.equal(error.code, 'WAYLAND_FIXTURE_OBSERVATION_REJECTED');
      assert.equal(String(error).includes('private-fixture'), false);
      assert.equal(JSON.stringify(error).includes(s.root), false); return true;
    });
  }
});
