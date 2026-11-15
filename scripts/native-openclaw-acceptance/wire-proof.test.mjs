import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { proveWireObservation } from './wire-proof.mjs';

const host = process.env.NATIVE_OPENCLAW_HOST;
assert.ok(host, 'Set NATIVE_OPENCLAW_HOST to the selected installed official host');
const sharp = createRequire(`${host}/package.json`)('sharp');
async function example() {
  const pixels = Buffer.alloc(200 * 160 * 3, 0);
  for (let y = 40; y < 80; y++) for (let x = 20; x < 80; x++) {
    const offset = (y * 200 + x) * 3;
    pixels.set([224, 48, 64], offset);
  }
  const bytes = await sharp(pixels, { raw: { width: 200, height: 160, channels: 3 } }).png().toBuffer();
  const receipt = { schemaVersion: 1, observationId: 'capture-one', capturedAtMs: Date.now(), requestedScope: { mode: 'window', annotationRequested: false }, primaryImage: { mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, sourceDimensions: { width: 200, height: 160 }, deliveredDimensions: { width: 200, height: 160 } }, coordinateReference: { units: 'normalized', sourceExtent: { x: 0, y: 0, width: 200, height: 160 } }, geometry: { state: 'available', coordinateUnits: 'macos-points', regions: [{ imageRect: { x: 0, y: 0, width: 200, height: 160 }, desktopRect: { x: -100, y: 20, width: 100, height: 80 } }] }, actualScope: { state: 'unavailable', reasonCode: 'PROVIDER_SCOPE_UNVERIFIED' } };
  const body = { messages: [{ role: 'user', content: 'NATIVE21_CASE:allowed' }, { role: 'tool', tool_call_id: 'native21-allowed-capture', content: JSON.stringify({ status: 'success', success: true, observationV1: receipt }) }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] }] };
  const fixture = { ready: true, pid: 123, windowNumber: 10, clicks: 0, desktopRect: { x: -100, y: 20, width: 100, height: 80 }, windowFrameRect: { x: -100, y: 20, width: 100, height: 80 }, backingScale: 2, targetRect: [10, 20, 30, 20] };
  const update = () => { body.messages[1].content = JSON.stringify({ status: 'success', success: true, observationV1: receipt }); };
  return { body, fixture, receipt, update, options: { sharp, fixture, platform: 'darwin', expectedCallId: 'native21-allowed-capture', captureStartedAtMs: receipt.capturedAtMs, seenObservationIds: new Set() } };
}
test('decoded provider pixels map through scale and negative origin to the independent fixture', async () => {
  const { body, options } = await example();
  const proof = await proveWireObservation(body, 'allowed', options);
  assert.deepEqual(proof.desktopPoint, [-75, 50]);
  assert.deepEqual(proof.imagePoint, [50, 60]);
  assert.equal(proof.actualProviderRequest, true);
  assert.equal(proof.effectVerified, false);
  assert.equal(proof.independentWindowExtentVerified, true);
  assert.equal(proof.deliveredPixelsPerPoint, 2);
  assert.deepEqual(proof.actualScope, { state: 'unavailable', reasonCode: 'PROVIDER_SCOPE_UNVERIFIED' });
  assert.ok(!JSON.stringify(proof).includes('base64'));
});

async function replaceRaster(sample, width, height, target, desktopRect) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = target[1]; y < target[3]; y++) for (let x = target[0]; x < target[2]; x++) pixels.set([224, 48, 64], (y * width + x) * 3);
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  sample.receipt.primaryImage = { mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, sourceDimensions: { width, height }, deliveredDimensions: { width, height } };
  sample.receipt.coordinateReference.sourceExtent = { x: 0, y: 0, width, height };
  sample.receipt.geometry.regions = [{ imageRect: { x: 0, y: 0, width, height }, desktopRect }];
  sample.body.messages[2].content[0].image_url.url = `data:image/png;base64,${bytes.toString('base64')}`;
  sample.update();
}

for (const variant of ['broader-screen', 'cropped-window']) test(`rejects ${variant} even with exactly mapped target pixels`, async () => {
  const sample = await example();
  if (variant === 'broader-screen') await replaceRaster(sample, 400, 320, [220, 240, 280, 280], { x: -200, y: -80, width: 200, height: 160 });
  else await replaceRaster(sample, 100, 80, [20, 40, 80, 80], { x: -100, y: 20, width: 50, height: 40 });
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options));
});

for (const variant of ['missing-frame', 'missing-scale', 'nonuniform-scale', 'unqualified-scale', 'wrong-coordinate-units', 'screen-scope', 'wrong-requested-scope']) test(`rejects independent scope evidence: ${variant}`, async () => {
  const sample = await example();
  if (variant === 'missing-frame') delete sample.fixture.windowFrameRect;
  if (variant === 'missing-scale') delete sample.fixture.backingScale;
  if (variant === 'unqualified-scale') sample.fixture.backingScale = 3;
  if (variant === 'nonuniform-scale') {
    sample.receipt.geometry.regions[0].desktopRect.height = 160;
    sample.fixture.windowFrameRect.height = 160;
    sample.fixture.desktopRect.height = 160;
    sample.fixture.targetRect = [10, 40, 30, 40];
  }
  if (variant === 'wrong-coordinate-units') sample.receipt.geometry.coordinateUnits = 'desktop-physical-pixels';
  if (variant === 'screen-scope') sample.receipt.actualScope = { state: 'available', mode: 'screen', evidence: 'PROVIDER_EXPLICIT_ARGUMENT' };
  if (variant === 'wrong-requested-scope') sample.receipt.requestedScope.mode = 'screen';
  sample.update();
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options));
});

test('Linux still requires a verified frontmost provider scope', async () => {
  const sample = await example(); sample.options.platform = 'linux';
  sample.receipt.requestedScope.mode = 'frontmost';
  sample.update();
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options));
});

test('an available window receipt remains separate from independent footprint evidence', async () => {
  const sample = await example();
  sample.receipt.actualScope = { state: 'available', mode: 'window', evidence: 'PROVIDER_EXPLICIT_ARGUMENT' };
  sample.update();
  const proof = await proveWireObservation(sample.body, 'allowed', sample.options);
  assert.equal(proof.independentWindowExtentVerified, true);
  assert.deepEqual(proof.actualScope, { state: 'available', mode: 'window', evidence: 'PROVIDER_EXPLICIT_ARGUMENT' });
});

test('a 1x complete window passes on a native 2x fixture', async () => {
  const sample = await example();
  await replaceRaster(sample, 100, 80, [10, 20, 40, 40], { x: -100, y: 20, width: 100, height: 80 });
  const proof = await proveWireObservation(sample.body, 'allowed', sample.options);
  assert.equal(proof.deliveredPixelsPerPoint, 1);
  assert.deepEqual(proof.desktopPoint, [-75, 50]);
});

test('Linux provider scope without an independent bracket must not authorize input', async () => {
  const sample = await example(); sample.options.platform = 'linux';
  sample.receipt.requestedScope.mode = 'frontmost';
  sample.receipt.actualScope = { state: 'available', mode: 'frontmost', evidence: 'PROVIDER_EXPLICIT_ARGUMENT' };
  delete sample.fixture.windowFrameRect; delete sample.fixture.backingScale;
  sample.update();
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options), /Independent Linux capture bracket required/);
});

test('both pixel-scale axes must meet the same native-scale tolerance', async () => {
  const sample = await example();
  const frame = { x: -100, y: 20, width: 200 / 2.009, height: 160 / 2.018 };
  sample.fixture.windowFrameRect = frame;
  sample.receipt.geometry.regions[0].desktopRect = { ...frame };
  sample.update();
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options));
});
for (const variant of ['hash', 'mime', 'dimensions', 'missing-image', 'duplicate-image', 'old-turn', 'unavailable', 'overlap', 'wrong-target']) test(`rejects ${variant} before a coordinate can authorize input`, async () => {
  const sample = await example(); const { body, fixture, receipt } = sample;
  if (variant === 'hash') receipt.primaryImage.sha256 = '0'.repeat(64);
  if (variant === 'mime') receipt.primaryImage.mimeType = 'image/jpeg';
  if (variant === 'dimensions') receipt.primaryImage.sourceDimensions.width = 201;
  if (variant === 'missing-image') body.messages.pop();
  if (variant === 'duplicate-image') body.messages.push(structuredClone(body.messages.at(-1)));
  if (variant === 'old-turn') body.messages.push({ role: 'user', content: 'NATIVE21_CASE:newer' });
  if (variant === 'unavailable') receipt.geometry.state = 'unavailable';
  if (variant === 'overlap') receipt.geometry.regions.push(structuredClone(receipt.geometry.regions[0]));
  if (variant === 'wrong-target') fixture.targetRect = [80, 60, 5, 5];
  sample.update();
  await assert.rejects(proveWireObservation(body, 'allowed', sample.options));
});

for (const variant of ['stale', 'wrong-call', 'reused-id', 'tiny-target', 'off-target-overlap']) test(`rejects review reproduction: ${variant}`, async () => {
  const sample = await example();
  if (variant === 'stale') sample.receipt.capturedAtMs = 1;
  if (variant === 'wrong-call') sample.body.messages[1].tool_call_id = 'old-unrelated-capture';
  if (variant === 'reused-id') sample.options.seenObservationIds.add(sample.receipt.observationId);
  if (variant === 'tiny-target') {
    const pixels = Buffer.alloc(200*160*3);
    for (let y=59;y<61;y++) for (let x=49;x<51;x++) pixels.set([224,48,64],(y*200+x)*3);
    const bytes = await sharp(pixels,{raw:{width:200,height:160,channels:3}}).png().toBuffer();
    sample.receipt.primaryImage.byteLength = bytes.length;
    sample.receipt.primaryImage.sha256 = createHash('sha256').update(bytes).digest('hex');
    sample.body.messages[2].content[0].image_url.url = `data:image/png;base64,${bytes.toString('base64')}`;
  }
  if (variant === 'off-target-overlap') sample.receipt.geometry.regions.push(...[1,2].map(() => ({imageRect:{x:150,y:0,width:40,height:20},desktopRect:{x:0,y:0,width:40,height:20}})));
  sample.update();
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options));
});

async function linuxExample() {
  const s = await example();
  s.options.platform = 'linux';
  s.fixture.desktopRect = { x: -100, y: 20, width: 200, height: 160 };
  s.fixture.targetRect = [20, 40, 60, 40];
  delete s.fixture.windowFrameRect; delete s.fixture.backingScale;
  s.receipt.requestedScope.mode = 'frontmost';
  s.receipt.actualScope = { state: 'available', mode: 'frontmost', evidence: 'PROVIDER_EXPLICIT_ARGUMENT' };
  s.receipt.geometry.coordinateUnits = 'desktop-physical-pixels';
  s.receipt.geometry.regions[0].desktopRect = { ...s.fixture.desktopRect };
  const at = s.receipt.capturedAtMs;
  const before = {pid:s.fixture.pid,processStartTicks:'123',windowId:s.fixture.windowNumber,window:{...s.fixture.desktopRect},root:{x:0,y:0,width:1280,height:960},startedAtMs:at-4,finishedAtMs:at-2,startedMonotonicMs:10,finishedMonotonicMs:12};
  const after = {...structuredClone(before),startedAtMs:at+2,finishedAtMs:at+4,startedMonotonicMs:14,finishedMonotonicMs:16};
  s.options.linuxScope = {before,after}; s.update(); return s;
}

test('Linux provider proof requires independently bracketed complete window extent', async () => {
  const s = await linuxExample();
  const proof = await proveWireObservation(s.body, 'allowed', s.options);
  assert.equal(proof.independentWindowExtentVerified, true);
  assert.equal(proof.linuxCaptureScope.independentExtentVerified, true);
  assert.equal(proof.linuxCaptureScope.windowId, s.fixture.windowNumber);
});
for (const variant of ['missing-bracket','changed-window','changed-process-birth','wrong-window-id','broader-screen','cropped-window','expired-bracket','reversed-clock','capture-outside-bracket']) test(`rejects Linux provider footprint: ${variant}`, async () => {
  const s = await linuxExample();
  if (variant === 'missing-bracket') delete s.options.linuxScope;
  if (variant === 'changed-window') s.options.linuxScope.after.window.width++;
  if (variant === 'changed-process-birth') s.options.linuxScope.after.processStartTicks = '124';
  if (variant === 'wrong-window-id') { s.options.linuxScope.before.windowId++; s.options.linuxScope.after.windowId++; }
  if (variant === 'broader-screen') await replaceRaster(s,400,320,[120,140,180,180],{x:-200,y:-80,width:400,height:320});
  if (variant === 'cropped-window') await replaceRaster(s,100,80,[20,40,80,80],{x:-100,y:20,width:100,height:80});
  if (variant === 'expired-bracket') s.options.linuxScope.after.finishedMonotonicMs += 21_000;
  if (variant === 'reversed-clock') s.options.linuxScope.after.startedMonotonicMs = 1;
  if (variant === 'capture-outside-bracket') s.options.linuxScope.before.finishedAtMs = s.receipt.capturedAtMs+1;
  await assert.rejects(proveWireObservation(s.body,'allowed',s.options));
});

for (const variant of ['plain-text', 'text-block', 'metadata', 'missing-block-type', 'assistant-role', 'tool-role']) test(`rejects provider bytes outside a supported image block: ${variant}`, async () => {
  const sample = await example(), image = sample.body.messages[2], url = image.content[0].image_url.url;
  if (variant === 'plain-text') image.content = url;
  if (variant === 'text-block') image.content = [{ type: 'text', text: url }];
  if (variant === 'metadata') image.content = [{ type: 'text', text: 'No image block', metadata: { url } }];
  if (variant === 'missing-block-type') delete image.content[0].type;
  if (variant === 'assistant-role') image.role = 'assistant';
  if (variant === 'tool-role') image.role = 'tool';
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options), /current-turn image/);
});

async function changeAlpha(sample, variant) {
  const original = Buffer.from(sample.body.messages[2].content[0].image_url.url.split(',')[1], 'base64');
  const { data, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (variant === 'transparent' || variant === 'translucent') {
    for (let offset = 3; offset < data.length; offset += 4) data[offset] = variant === 'transparent' ? 0 : 128;
  } else if (variant === 'target-border') {
    for (let y = 40; y < 80; y++) for (let x = 20; x < 80; x++) {
      if (x === 20 || x === 79 || y === 40 || y === 79) data[(y * info.width + x) * 4 + 3] = 0;
    }
  } else {
    const [x, y] = variant === 'target-hole' ? [30, 50] : [0, 0];
    data[(y * info.width + x) * 4 + 3] = 0;
  }
  const bytes = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  sample.receipt.primaryImage.byteLength = bytes.length;
  sample.receipt.primaryImage.sha256 = createHash('sha256').update(bytes).digest('hex');
  sample.body.messages[2].content[0].image_url.url = `data:image/png;base64,${bytes.toString('base64')}`;
  sample.update();
}

for (const variant of ['transparent', 'translucent', 'target-hole', 'target-border']) test(`rejects hidden target RGB: ${variant}`, async () => {
  const sample = await example(); await changeAlpha(sample, variant);
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options));
});

test('unrelated transparent background does not invalidate an opaque target', async () => {
  const sample = await example(); await changeAlpha(sample, 'background-hole');
  assert.deepEqual((await proveWireObservation(sample.body, 'allowed', sample.options)).desktopPoint, [-75, 50]);
});

for (const variant of ['negative-local-origin', 'beyond-fixture-edge']) test(`rejects target outside the fixture despite edge tolerance: ${variant}`, async () => {
  const sample = await example();
  sample.fixture.targetRect = variant === 'negative-local-origin' ? [-1, 20, 31, 20] : [70, 20, 31, 20];
  const target = variant === 'negative-local-origin' ? [0, 40, 60, 80] : [140, 40, 200, 80];
  await replaceRaster(sample, 200, 160, target, { x: -100, y: 20, width: 100, height: 80 });
  await assert.rejects(proveWireObservation(sample.body, 'allowed', sample.options), /inside the fixture/);
});
