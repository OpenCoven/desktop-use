import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { proveCaptureScope } from './linux-scope-proof.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function text(content) {
  return typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}
function rectangle(value) {
  assert.ok(value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])), 'Finite geometry required');
  assert.ok(value.width > 0 && value.height > 0, 'Positive geometry extent required');
  return value;
}
const contains = (rect, point) => point[0] >= rect.x && point[1] >= rect.y && point[0] < rect.x + rect.width && point[1] < rect.y + rect.height;

// This verifies provider-wire content, not its native provenance or an effect.
// The opt-in runner must separately bind actual helper/fixture identities.
export async function proveWireObservation(body, marker, { sharp, fixture, platform, expectedCallId, captureStartedAtMs, seenObservationIds, linuxScope }) {
  assert.ok(['darwin', 'linux'].includes(platform), 'Explicit native platform required');
  assert.ok(Array.isArray(body.messages) && body.messages.length <= 300, 'Bounded provider messages required');
  assert.match(marker, /^[a-z0-9-]{1,80}$/);
  const marked = body.messages.flatMap((message, index) => message.role === 'user'
    ? [...text(message.content).matchAll(/NATIVE21_CASE:([a-z0-9-]+)(?![a-z0-9-])/g)].map(match => ({ name: match[1], index })) : []);
  assert.equal(marked.at(-1)?.name, marker, 'Current turn must be the requested marker');
  assert.equal(marked.filter(turn => turn.name === marker).length, 1, 'Turn marker must be unique');
  const current = body.messages.slice(marked.at(-1).index + 1);
  const images = [];
  function walk(value) {
    if (typeof value === 'string' && /^data:image\/(?:png|jpeg);base64,/.test(value)) images.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  }
  walk(current);
  assert.equal(images.length, 1, 'Exactly one current-turn image required');
  const observations = current.filter(message => message.role === 'tool').flatMap(message => {
    try { const details = JSON.parse(text(message.content)); return details?.observationV1 ? [{ message, details }] : []; } catch { return []; }
  });
  assert.equal(observations.length, 1, 'Exactly one current-turn observation required');
  assert.equal(observations[0].message.tool_call_id, expectedCallId, 'Observation must belong to the actual capture call');
  assert.ok(typeof expectedCallId === 'string' && Number.isFinite(captureStartedAtMs) && seenObservationIds instanceof Set, 'Explicit current capture binding required');
  const details = observations.map(value => value.details);
  assert.equal(details.length, 1, 'Exactly one current-turn observation required');
  assert.equal(details[0].success, true, 'Successful observation required');
  const observation = details[0].observationV1;
  assert.equal(observation.schemaVersion, 1, 'Versioned observation required');
  assert.ok(typeof observation.observationId === 'string' && observation.observationId.length > 0 && !seenObservationIds.has(observation.observationId), 'A unique unreused observation identity is required');
  assert.ok(Number.isSafeInteger(observation.capturedAtMs) && observation.capturedAtMs >= captureStartedAtMs && observation.capturedAtMs <= Date.now(), 'Capture must be fresh for this exact call');
  const primary = observation.primaryImage;
  assert.ok(images[0].length <= 24 * 1024 * 1024, 'Bounded image required');
  const [, mimeType, encoded] = images[0].match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/) ?? [];
  assert.ok(mimeType && encoded, 'Canonical PNG/JPEG image required');
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'Canonical image encoding required');
  assert.equal(mimeType, primary.mimeType, 'Image MIME must match receipt');
  assert.equal(bytes.length, primary.byteLength, 'Image length must match receipt');
  assert.equal(sha256(bytes), primary.sha256, 'Image hash must match receipt');
  const metadata = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning' }).metadata();
  assert.equal(metadata.format, mimeType === 'image/png' ? 'png' : 'jpeg', 'Decoded image encoding must match MIME');
  const dimensions = { width: metadata.width, height: metadata.height };
  assert.deepEqual(dimensions, primary.sourceDimensions, 'Source dimensions must match pixels');
  assert.deepEqual(dimensions, primary.deliveredDimensions, 'Fresh-delivery dimensions must match pixels');
  assert.equal(observation.coordinateReference?.units, 'normalized');
  assert.deepEqual(observation.coordinateReference.sourceExtent, { x: 0, y: 0, ...dimensions });
  assert.equal(observation.geometry?.state, 'available', 'Available geometry required');
  assert.ok(observation.geometry.regions.length > 0 && observation.geometry.regions.length <= 16, 'Bounded mapping regions required');
  const regions = observation.geometry.regions;
  for (const region of regions) {
    rectangle(region.imageRect); rectangle(region.desktopRect);
    assert.ok(region.imageRect.x >= 0 && region.imageRect.y >= 0 && region.imageRect.x + region.imageRect.width <= dimensions.width && region.imageRect.y + region.imageRect.height <= dimensions.height, 'Image region must fit source raster');
  }
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i].imageRect, b = regions[j].imageRect;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'Mapping regions must not overlap anywhere');
  }
  let independentWindow;
  if (platform === 'darwin') {
    assert.equal(observation.requestedScope?.mode, 'window', 'Explicit fixture-window request required');
    const scope = observation.actualScope;
    assert.ok(scope?.state === 'unavailable' && scope.reasonCode === 'PROVIDER_SCOPE_UNVERIFIED'
      || scope?.state === 'available' && scope.mode === 'window' && scope.evidence === 'PROVIDER_EXPLICIT_ARGUMENT', 'Provider scope must not contradict the independent window proof');
    assert.equal(observation.geometry.coordinateUnits, 'macos-points', 'AppKit frame requires geometry in macOS points');
    const frame = rectangle(fixture.windowFrameRect);
    assert.ok(Number.isFinite(fixture.backingScale) && fixture.backingScale > 0, 'Independent fixture backing scale required');
    assert.equal(regions.length, 1, 'One complete owned-window mapping required');
    assert.deepEqual(regions[0].imageRect, { x: 0, y: 0, ...dimensions }, 'The complete raster must belong to the window mapping');
    const mapped = regions[0].desktopRect;
    const edges = rect => [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
    assert.ok(edges(mapped).every((value, edge) => Math.abs(value - edges(frame)[edge]) <= 1), 'Complete capture extent must match the independent AppKit window frame');
    const scale = dimensions.width / frame.width;
    assert.ok(Math.abs(scale - dimensions.height / frame.height) <= .01, 'Complete window must have uniform pixel scale');
    assert.ok([1, fixture.backingScale].some(allowed => [scale, dimensions.height / frame.height].every(value => Math.abs(value - allowed) <= .01)), 'Both pixel-scale axes must match the same 1x or independent native backing scale');
    independentWindow = { windowFrameRect: frame, deliveredPixelsPerPoint: scale, windowExtentTolerancePoints: 1, scaleTolerance: .01 };
  } else {
    assert.equal(observation.requestedScope?.mode, 'frontmost', 'Explicit frontmost request required');
    assert.equal(observation.actualScope?.state, 'available', 'Verified Linux frontmost provider scope required');
    assert.equal(observation.actualScope.mode, 'frontmost', 'Native capture must retain requested fixture scope');
    assert.ok(linuxScope?.before && linuxScope?.after, 'Independent Linux capture bracket required before input');
    assert.equal(linuxScope.before.windowId, fixture.windowNumber, 'Independent X11 window must be the selected owned fixture');
    const frame = rectangle(fixture.desktopRect);
    const scope = proveCaptureScope({mode:'frontmost',before:linuxScope.before,after:linuxScope.after,receipt:observation,fixture:{pid:fixture.pid,origin:[frame.x,frame.y],size:[frame.width,frame.height]},decodedDimensions:dimensions});
    independentWindow = {linuxCaptureScope:scope};
  }
  assert.ok(Number.isSafeInteger(fixture.clicks) && fixture.clicks >= 0, 'Known fixture counter required');
  const color = fixture.clicks === 0 ? [224, 48, 64] : [32, 192, 96];
  const { data, info } = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tolerance = 16;
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const offset = (y * info.width + x) * info.channels;
    if (color.every((value, channel) => Math.abs(data[offset + channel] - value) <= tolerance)) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++;
    }
  }
  assert.ok(count > 0, 'Known fixture target pixels required');
  const targetPixelBounds = [minX, minY, maxX + 1, maxY + 1];
  assert.ok(count / ((maxX + 1 - minX) * (maxY + 1 - minY)) > .9, 'Target pixels must form a filled rectangle');
  const imagePoint = [(minX + maxX + 1) / 2, (minY + maxY + 1) / 2];
  const matches = regions.filter(region => contains(region.imageRect, imagePoint));
  assert.equal(matches.length, 1, 'Target must have one unambiguous mapping');
  const { imageRect: source, desktopRect: desktop } = matches[0];
  const desktopPoint = [desktop.x + (imagePoint[0] - source.x) * desktop.width / source.width, desktop.y + (imagePoint[1] - source.y) * desktop.height / source.height];
  const expected = rectangle(fixture.desktopRect), target = fixture.targetRect;
  assert.ok(Array.isArray(target) && target.length === 4 && target.every(Number.isFinite) && target[2] > 0 && target[3] > 0, 'Independent fixture target required');
  const expectedDesktopPoint = [expected.x + target[0] + target[2] / 2, expected.y + target[1] + target[3] / 2];
  assert.ok(desktopPoint.every((value, axis) => Math.abs(value - expectedDesktopPoint[axis]) <= 2), 'Mapped pixels must match independent fixture target');
  const mappedBounds = [desktop.x + (minX - source.x) * desktop.width / source.width, desktop.y + (minY - source.y) * desktop.height / source.height, desktop.x + (maxX + 1 - source.x) * desktop.width / source.width, desktop.y + (maxY + 1 - source.y) * desktop.height / source.height];
  assert.ok(minX >= source.x && minY >= source.y && maxX + 1 <= source.x + source.width && maxY + 1 <= source.y + source.height, 'One mapping must cover the complete target');
  const expectedBounds = [expected.x + target[0], expected.y + target[1], expected.x + target[0] + target[2], expected.y + target[1] + target[3]];
  assert.ok(mappedBounds.every((value, edge) => Math.abs(value - expectedBounds[edge]) <= 2), 'Mapped target extent must match all independent fixture edges');
  assert.ok(contains(expected, desktopPoint), 'Mapped target must remain inside the fixture');
  seenObservationIds.add(observation.observationId);
  return { actualProviderRequest: true, effectVerified: false, observationId: observation.observationId, capturedAtMs: observation.capturedAtMs, toolCallId: expectedCallId, sha256: primary.sha256, byteLength: bytes.length, mimeType, dimensions, imagePoint, desktopPoint, expectedDesktopPoint, targetPixelBounds, mappedBounds, colorTolerance: tolerance, colorManaged: Boolean(metadata.icc), geometryState: 'available', actualScope: observation.actualScope, independentWindowExtentVerified: Boolean(independentWindow), ...independentWindow };
}
