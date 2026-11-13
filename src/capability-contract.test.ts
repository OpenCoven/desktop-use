import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { CANONICAL_ACTIONS } from "./computer-use-actions.js";

test("shared capability fixtures enforce every canonical action and reject incompatible contracts", async () => {
  const root = new URL("../contracts/v1/", import.meta.url);
  const schema = JSON.parse(await readFile(new URL("capabilities.schema.json", root), "utf8"));
  // Ajv's NodeNext CommonJS declaration has a namespace default export.
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  assert.deepEqual(schema.properties.actions.required, [...CANONICAL_ACTIONS]);
  const fixtures = await readdir(new URL("fixtures/capabilities/", root));
  assert.ok(fixtures.length >= 8, "shared platform/protocol/permission fixtures must exist");
  for (const name of fixtures.filter(name => name.endsWith(".json"))) {
    const fixture = JSON.parse(await readFile(new URL(`fixtures/capabilities/${name}`, root), "utf8"));
    assert.equal(validate(fixture.report), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const missing = structuredClone(fixture.report);
    delete missing.actions["type-text"];
    assert.equal(validate(missing), false, name);
    const unknown = structuredClone(fixture.report);
    unknown.schemaVersion = 2;
    assert.equal(validate(unknown), false, name);
    const alias = structuredClone(fixture.report);
    alias.actions.typing = alias.actions["type-text"];
    assert.equal(validate(alias), false, name);
    const badSelector = structuredClone(fixture.report);
    badSelector.actions.screenshot.variants.push({ mode: null, selectors: ["window-title"], provider: { name: "unknown", version: null }, limits: { constraints: [], parameters: {} }, state: "available", reasonCodes: [] });
    assert.equal(validate(badSelector), false, name);
    const auto = structuredClone(fixture.report);
    auto.actions.screenshot.variants.push({ mode: "auto", selectors: [], provider: { name: "unknown", version: null }, limits: { constraints: [], parameters: {} }, state: "available", reasonCodes: [] });
    assert.equal(validate(auto), false, name);
  }
});
