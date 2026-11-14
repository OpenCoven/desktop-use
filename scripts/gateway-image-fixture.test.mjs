import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { inspectProviderImage } from "./gateway-image-fixture.mjs";

test("provider proof checks the current image turn without confusing retained history", async () => {
  const bytes = await readFile(new URL("../contracts/v1/fixtures/images/valid.jpg", import.meta.url));
  const receipt = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/observations/valid-jpg.json", import.meta.url)));
  const body = { messages: [
    { role: "user", content: "prior capture" },
    { role: "tool", content: JSON.stringify({ observationV1: { invalid: true } }) },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,cHJpb3I=" } }] },
    { role: "user", content: "QUALIFICATION_CASE:synthetic-image-jpg" },
    { role: "tool", content: JSON.stringify({ observationV1: receipt }) },
    { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` } }] },
  ] };
  const proof = await inspectProviderImage(body, { bytes, mimeType: "image/jpeg", sha256: receipt.primaryImage.sha256 });
  assert.equal(proof.exactImageBytes, true);
  body.messages.at(-1).content[0].image_url.url = "data:image/jpeg;base64,d3Jvbmc=";
  await assert.rejects(inspectProviderImage(body, { bytes, mimeType: "image/jpeg", sha256: receipt.primaryImage.sha256 }));
});

test("large provider image preserves normalized landmarks after host resize", async () => {
  const { default: jpeg } = await import("jpeg-js");
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(new URL("../contracts/v1/fixtures/images/geometry-3200x1800.png", import.meta.url));
  const raw = Buffer.alloc(1200*675*4);
  for (let y=0;y<675;y++) for (let x=0;x<1200;x++) {
    const color = [Math.round(16+224*(x+.5)/1200),Math.round(16+224*(y+.5)/675),32+64*(x>=600)+128*(y>=337.5)];
    raw.set([...color,255],(y*1200+x)*4);
  }
  const converted = jpeg.encode({width:1200,height:675,data:raw},85).data;
  const receipt = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/observations/valid-png.json", import.meta.url)));
  receipt.primaryImage = { ...receipt.primaryImage, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sourceDimensions: { width:3200, height:1800 }, deliveredDimensions: { width:3200, height:1800 } };
  receipt.coordinateReference.sourceExtent = { x:0,y:0,width:3200,height:1800 };
  const body = { messages: [{ role:"user",content:"QUALIFICATION_CASE:large" },{role:"tool",content:JSON.stringify({observationV1:receipt})},{role:"user",content:[{type:"image_url",image_url:{url:`data:image/jpeg;base64,${converted.toString("base64")}`}}]}] };
  body.messages.push({role:"user",content:"QUALIFICATION_CASE:replay"});
  const replay = {stage:"history-replay",sourceCase:"large",currentCase:"replay"};
  const expected = {bytes,mimeType:"image/png",sha256:receipt.primaryImage.sha256,width:3200,height:1800,allowHostResize:true};
  const proof = await inspectProviderImage(body,expected,replay);
  assert.equal(proof.normalizedLandmarksPreserved,true);
  assert.deepEqual(proof.providerDimensions,{width:1200,height:675});
  assert.equal(proof.stage,"history-replay");
  assert.equal(proof.sourceCase,"large");
  assert.equal(proof.currentCase,"replay");
  assert.equal(proof.exactImageBytes,false);
  assert.equal(proof.frameSamples,100);
  assert.equal(proof.channelTolerance,4);
  assert.equal(proof.sourceImage.mimeType,"image/png");
  assert.equal(proof.providerImage.mimeType,"image/jpeg");
  assert.equal(proof.providerImage.byteLength,converted.length);
  assert.notEqual(proof.sourceImage.sha256,proof.providerImage.sha256);
  // An unrelated later turn must not contaminate the explicitly bounded source.
  const unrelated = { role:"user",content:"QUALIFICATION_CASE:unrelated" };
  const withUnrelated = { messages:[...body.messages.slice(0,-1),unrelated,body.messages[2],body.messages.at(-1)] };
  assert.deepEqual(await inspectProviderImage(withUnrelated,expected,replay),proof);
  const wrongExtent = structuredClone(body);
  const summary = JSON.parse(wrongExtent.messages[1].content);
  summary.observationV1.coordinateReference.sourceExtent.width = 1200;
  wrongExtent.messages[1].content = JSON.stringify(summary);
  await assert.rejects(inspectProviderImage(wrongExtent,expected,replay));
  // Center crop to 60% of each source dimension, then resize: quadrant centers
  // alone falsely accept this changed coordinate frame.
  const cropped = Buffer.alloc(raw.length);
  for (let y=0;y<675;y++) for(let x=0;x<1200;x++) {
    const sx=Math.floor(240+x*.6), sy=Math.floor(135+y*.6);
    raw.copy(cropped,(y*1200+x)*4,(sy*1200+sx)*4,(sy*1200+sx+1)*4);
  }
  body.messages.at(-2).content[0].image_url.url=`data:image/jpeg;base64,${jpeg.encode({width:1200,height:675,data:cropped},85).data.toString("base64")}`;
  await assert.rejects(inspectProviderImage(body,expected,replay));
  const mirrored = Buffer.alloc(raw.length);
  for (let y=0;y<675;y++) for(let x=0;x<1200;x++) raw.copy(mirrored,(y*1200+x)*4,(y*1200+1199-x)*4,(y*1200+1200-x)*4);
  const bad = jpeg.encode({width:1200,height:675,data:mirrored},85).data;
  body.messages.at(-2).content[0].image_url.url=`data:image/jpeg;base64,${bad.toString("base64")}`;
  await assert.rejects(inspectProviderImage(body,expected,replay));
});

async function largeSource() {
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(new URL("../contracts/v1/fixtures/images/geometry-3200x1800.png", import.meta.url));
  const receipt = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/observations/valid-png.json", import.meta.url)));
  const dimensions = { width: 3200, height: 1800 };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  Object.assign(receipt.primaryImage, { byteLength: bytes.length, sha256, sourceDimensions: dimensions, deliveredDimensions: dimensions });
  receipt.coordinateReference.sourceExtent = { x: 0, y: 0, ...dimensions };
  return { expected: { bytes, mimeType: "image/png", sha256, ...dimensions, allowHostResize: true }, messages: [
    { role: "user", content: "QUALIFICATION_CASE:large" },
    { role: "tool", content: JSON.stringify({ observationV1: receipt }) },
    { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } }] },
  ] };
}

test("fresh large provider image requires exact original PNG and reports no decoded samples", async () => {
  const { expected, messages } = await largeSource();
  const proof = await inspectProviderImage({ messages }, expected, { currentCase: "large" });
  assert.equal(proof.exactImageBytes, true);
  assert.equal(proof.hostResize, false);
  assert.equal(proof.frameSamples, undefined);
  assert.deepEqual(proof.sourceImage, proof.providerImage);
  assert.deepEqual(proof.providerImage.dimensions, { width: 3200, height: 1800 });
  messages.at(-1).content[0].image_url.url = "data:image/jpeg;base64,d3Jvbmc=";
  await assert.rejects(inspectProviderImage({ messages }, expected, { currentCase: "large" }));
});

test("explicit replay rejects missing, ambiguous, wrong-turn and unrelated images", async () => {
  const { expected, messages } = await largeSource();
  const replay = { stage: "history-replay", sourceCase: "large", currentCase: "replay" };
  const marker = name => ({ role: "user", content: `QUALIFICATION_CASE:${name}` });
  const image = messages.at(-1);
  // The only image is in a later unrelated turn: an unbounded historical scan would accept it.
  await assert.rejects(inspectProviderImage({ messages: [messages[0], messages[1], marker("unrelated"), image, marker("replay")] }, expected, replay), /one image/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("large"), marker("replay")] }, expected, replay), /unique/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay")] }, expected, { ...replay, sourceCase: "missing" }), /unique/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay")] }, expected, { ...replay, sourceCase: "replay" }), /prior/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay"), image] }, expected), /observation/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, image, marker("replay")] }, expected, replay), /one image/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay")] }, expected, replay), /JPEG/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay-extra")] }, expected, replay), /current/);
});
