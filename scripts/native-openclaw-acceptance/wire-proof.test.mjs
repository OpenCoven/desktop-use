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
  const receipt = { schemaVersion: 1, observationId: 'capture-one', capturedAtMs: Date.now(), primaryImage: { mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, sourceDimensions: { width: 200, height: 160 }, deliveredDimensions: { width: 200, height: 160 } }, coordinateReference: { units: 'normalized', sourceExtent: { x: 0, y: 0, width: 200, height: 160 } }, geometry: { state: 'available', regions: [{ imageRect: { x: 0, y: 0, width: 200, height: 160 }, desktopRect: { x: -100, y: 20, width: 100, height: 80 } }] }, actualScope: { mode: 'window' } };
  const body = { messages: [{ role: 'user', content: 'NATIVE21_CASE:allowed' }, { role: 'tool', tool_call_id: 'native21-allowed-capture', content: JSON.stringify({ status: 'success', success: true, observationV1: receipt }) }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] }] };
  const fixture = { ready: true, pid: 123, windowNumber: 10, clicks: 0, desktopRect: { x: -100, y: 20, width: 100, height: 80 }, targetRect: [10, 20, 30, 20] };
  const update = () => { body.messages[1].content = JSON.stringify({ status: 'success', success: true, observationV1: receipt }); };
  return { body, fixture, receipt, update, options: { sharp, fixture, expectedCallId: 'native21-allowed-capture', captureStartedAtMs: receipt.capturedAtMs, seenObservationIds: new Set() } };
}
test('decoded provider pixels map through scale and negative origin to the independent fixture', async () => {
  const { body, options } = await example();
  const proof = await proveWireObservation(body, 'allowed', options);
  assert.deepEqual(proof.desktopPoint, [-75, 50]);
  assert.deepEqual(proof.imagePoint, [50, 60]);
  assert.equal(proof.actualProviderRequest, true);
  assert.equal(proof.effectVerified, false);
  assert.ok(!JSON.stringify(proof).includes('base64'));
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
