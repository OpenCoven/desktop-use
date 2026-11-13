// Qualification-only helpers. No production adapter platform override and no native desktop access.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
  const helper = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const i=args.indexOf('--path');const path=i>=0?args[i+1]:args.at(-1);if(!path||!path.includes('.desktopuse-capture-'))process.exit(2);fs.copyFileSync(path.endsWith('.jpg')?${JSON.stringify(fixtures.jpg.path)}:${JSON.stringify(fixtures.png.path)},path);console.log(JSON.stringify({success:true}));\n`;
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
  assert.equal(mimeType, expected.mimeType);
  assert.deepEqual(Buffer.from(data, "base64"), expected.bytes, "Provider received exact synthetic bytes");
  const summaries = messages.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : m.content?.filter(c => c.type === "text").map(c => c.text).join("\n"));
  const details = summaries.map(text => { try { return JSON.parse(text); } catch { return undefined; } }).findLast(value => value?.observationV1);
  assert.ok(details?.observationV1, "Provider receives observation coordinates as structured text");
  const receipt = details.observationV1;
  assert.deepEqual(receipt.primaryImage.sourceDimensions, { width: 32, height: 24 });
  assert.deepEqual(receipt.primaryImage.deliveredDimensions, { width: 32, height: 24 });
  assert.deepEqual(receipt.coordinateReference, { units: "normalized", extent: { x: 0, y: 0, width: 1, height: 1 }, sourceExtent: { x: 0, y: 0, width: 32, height: 24 } });
  assert.equal(receipt.primaryImage.sha256, expected.sha256);
  assert.equal(receipt.geometry.state, "unavailable");
  return { synthetic: true, actualProviderRequest: true, exactImageBytes: true, mimeType, byteLength: expected.bytes.length, sha256: expected.sha256, sourceDimensions: receipt.primaryImage.sourceDimensions, deliveredDimensions: receipt.primaryImage.deliveredDimensions, coordinateReference: receipt.coordinateReference, geometry: receipt.geometry, actualScope: receipt.actualScope, annotationKind: receipt.primaryImage.annotationKind, nativeAcceptance: false, liveProvider: false };
}
