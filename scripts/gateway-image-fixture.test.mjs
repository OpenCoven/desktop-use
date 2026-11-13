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
  const proof = await inspectProviderImage(body,{bytes,mimeType:"image/png",sha256:receipt.primaryImage.sha256,width:3200,height:1800,allowHostResize:true});
  assert.equal(proof.normalizedLandmarksPreserved,true);
  assert.deepEqual(proof.providerDimensions,{width:1200,height:675});
  // Center crop to 60% of each source dimension, then resize: quadrant centers
  // alone falsely accept this changed coordinate frame.
  const cropped = Buffer.alloc(raw.length);
  for (let y=0;y<675;y++) for(let x=0;x<1200;x++) {
    const sx=Math.floor(240+x*.6), sy=Math.floor(135+y*.6);
    raw.copy(cropped,(y*1200+x)*4,(sy*1200+sx)*4,(sy*1200+sx+1)*4);
  }
  body.messages.at(-1).content[0].image_url.url=`data:image/jpeg;base64,${jpeg.encode({width:1200,height:675,data:cropped},85).data.toString("base64")}`;
  await assert.rejects(inspectProviderImage(body,{bytes,mimeType:"image/png",sha256:receipt.primaryImage.sha256,width:3200,height:1800,allowHostResize:true}));
  const mirrored = Buffer.alloc(raw.length);
  for (let y=0;y<675;y++) for(let x=0;x<1200;x++) raw.copy(mirrored,(y*1200+x)*4,(y*1200+1199-x)*4,(y*1200+1200-x)*4);
  const bad = jpeg.encode({width:1200,height:675,data:mirrored},85).data;
  body.messages.at(-1).content[0].image_url.url=`data:image/jpeg;base64,${bad.toString("base64")}`;
  await assert.rejects(inspectProviderImage(body,{bytes,mimeType:"image/png",sha256:receipt.primaryImage.sha256,width:3200,height:1800,allowHostResize:true}));
});
