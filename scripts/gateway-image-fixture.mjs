// Qualification-only helpers. No production adapter platform override and no native desktop access.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";

export async function createImageFixture(repo, root) {
  assert.ok(["darwin", "linux"].includes(process.platform), "Synthetic capture fixture supports native macOS/Linux builds");
  const binary = join(repo, "target/debug/coven-desktop-use"); await access(binary);
  const helpers = join(root, "capture-helpers"); await mkdir(helpers, { mode: 0o700 });
  const marker = join(root, "enable-synthetic-capture");
  const fixtures = {};
  for (const kind of ["png", "jpg"]) {
    const bytes = await readFile(join(repo, `contracts/v1/fixtures/images/valid.${kind}`));
    const path = join(root, `synthetic-capture.${kind}`); await writeFile(path, bytes, { mode: 0o600 });
    fixtures[kind] = { bytes, path, mimeType: kind === "png" ? "image/png" : "image/jpeg", sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const largeBytes = await readFile(join(repo, "contracts/v1/fixtures/images/geometry-3200x1800.png"));
  const largePath = join(root, "synthetic-large.png"); await writeFile(largePath, largeBytes, { mode: 0o600 });
  fixtures.large = { bytes: largeBytes, path: largePath, mimeType: "image/png", sha256: createHash("sha256").update(largeBytes).digest("hex"), width: 3200, height: 1800, allowHostResize: true };
  const helper = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const i=args.indexOf('--path');const path=i>=0?args[i+1]:args.at(-1);if(!path||!path.includes('.desktopuse-capture-'))process.exit(2);fs.copyFileSync(fs.readFileSync(${JSON.stringify(marker)},'utf8')==='large'?${JSON.stringify(largePath)}:path.endsWith('.jpg')?${JSON.stringify(fixtures.jpg.path)}:${JSON.stringify(fixtures.png.path)},path);console.log(JSON.stringify({success:true}));\n`;
  for (const name of ["peekaboo", "scrot"]) await writeFile(join(helpers, name), helper, { mode: 0o700 });
  const adapter = join(root, "synthetic-adapter.cjs");
  await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(!fs.existsSync(${JSON.stringify(marker)})||!['screenshot','inspect'].includes(args[0])){console.log(JSON.stringify({ok:false,code:'ENOENT',error:'Qualification adapter deliberately unavailable outside synthetic capture.'}));process.exit(0);}const result=cp.spawnSync(${JSON.stringify(binary)},args,{encoding:'utf8',env:{PATH:${JSON.stringify(helpers)},XDG_SESSION_TYPE:'x11',DISPLAY:':synthetic-fixture'}});process.stdout.write(result.stdout||'');process.exit(result.status??1);\n`, { mode: 0o700 });
  return { adapter, marker, fixtures, binary };
}

export async function inspectProviderImage(body, expected) {
  const urls = [];
  function walk(value) {
    if (typeof value === "string" && /^data:image\/(png|jpeg);base64,/.test(value)) urls.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  }
  const marker = body.messages.findLastIndex(m => m.role === "user" && JSON.stringify(m.content).includes("QUALIFICATION_CASE:"));
  assert.ok(marker >= 0, "Current qualification turn is identifiable");
  const messages = body.messages.slice(marker + 1);
  walk(messages);
  assert.equal(urls.length, 1, "Actual provider request contains one image");
  const [, mimeType, data] = urls[0].match(/^data:(image\/(?:png|jpeg));base64,(.*)$/s) ?? [];
  const providerBytes = Buffer.from(data, "base64");
  let resizeProof = {};
  if (expected.allowHostResize) {
    assert.equal(mimeType, "image/jpeg", "Pinned host converts oversized PNG to JPEG");
    const decoded = jpeg.decode(providerBytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
    assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 1200, height: 675 }, "Pinned default host resize dimensions");
    // Sample both coordinate ramps across the full frame, including near its
    // edges. Broad solid quadrants alone cannot detect centered cropping.
    const positions = [.02,.08,.17,.29,.41,.59,.71,.83,.92,.98];
    for (const y of positions) for (const x of positions) {
      const px = Math.floor(x*decoded.width), py = Math.floor(y*decoded.height);
      const offset = (py*decoded.width+px)*4;
      const rgb = [16+224*(px+.5)/decoded.width,16+224*(py+.5)/decoded.height,32+64*(x>=.5)+128*(y>=.5)];
      assert.ok(rgb.every((v,index) => Math.abs(v-decoded.data[offset+index])<=4), "Position-coded landmark survives resize within four channel levels");
    }
    resizeProof = { normalizedLandmarksPreserved: true, frameSamples: 100, channelTolerance: 4, providerDimensions: { width: decoded.width, height: decoded.height }, providerSha256: createHash("sha256").update(providerBytes).digest("hex"), hostResize: true };
  } else {
    assert.equal(mimeType, expected.mimeType);
    assert.deepEqual(providerBytes, expected.bytes, "Provider received exact synthetic bytes");
  }
  const summaries = messages.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : m.content?.filter(c => c.type === "text").map(c => c.text).join("\n"));
  const details = summaries.map(text => { try { return JSON.parse(text); } catch { return undefined; } }).findLast(value => value?.observationV1);
  assert.ok(details?.observationV1, "Provider receives observation coordinates as structured text");
  const receipt = details.observationV1;
  const dimensions = { width: expected.width ?? 32, height: expected.height ?? 24 };
  assert.deepEqual(receipt.primaryImage.sourceDimensions, dimensions);
  assert.deepEqual(receipt.primaryImage.deliveredDimensions, dimensions);
  assert.deepEqual(receipt.coordinateReference, { units: "normalized", extent: { x: 0, y: 0, width: 1, height: 1 }, sourceExtent: { x: 0, y: 0, ...dimensions } });
  assert.equal(receipt.primaryImage.sha256, expected.sha256);
  assert.equal(receipt.geometry.state, "unavailable");
  return { synthetic: true, actualProviderRequest: true, exactImageBytes: !expected.allowHostResize, ...resizeProof, mimeType, byteLength: expected.bytes.length, sha256: expected.sha256, sourceDimensions: receipt.primaryImage.sourceDimensions, deliveredDimensions: receipt.primaryImage.deliveredDimensions, coordinateReference: receipt.coordinateReference, geometry: receipt.geometry, actualScope: receipt.actualScope, annotationKind: receipt.primaryImage.annotationKind, nativeAcceptance: false, liveProvider: false };
}
