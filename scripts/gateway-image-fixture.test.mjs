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
