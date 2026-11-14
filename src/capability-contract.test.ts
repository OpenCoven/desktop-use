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
  for (const name of ["x11-empty.json", "x11-xdotool-only.json"]) {
    assert.ok(fixtures.includes(name), `missing setup-diagnostic fixture ${name}`);
    const { report } = JSON.parse(await readFile(new URL(`fixtures/capabilities/${name}`, root), "utf8"));
    assert.equal(validate(report), true, `${name}: ${JSON.stringify(validate.errors)}`);
    for (const action of ["inspect", "screenshot"]) {
      assert.equal(report.actions[action].state, "unsupported", `${name}/${action}`);
      for (const variant of report.actions[action].variants.filter((variant: any) => variant.mode !== null)) {
        assert.equal(variant.state, "unsupported", `${name}/${action}/${variant.mode}`);
        assert.deepEqual(variant.reasonCodes, ["HELPER_MISSING"]);
      }
    }
  }
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

test("shared grim formats keep unknown and disabled JPEG builds out of available choices", async () => {
  const root = new URL("../contracts/v1/", import.meta.url);
  const schema = JSON.parse(await readFile(new URL("capabilities.schema.json", root), "utf8"));
  const validate = new Ajv2020.default({ strict: true, allErrors: true }).compile(schema);
  for (const [name, state, knowledge] of [
    ["wayland-advertised", "unverified", "unknown"],
    ["wayland-grim-jpeg-disabled", "unsupported", "known"],
    ["wayland-grim-jpeg-enabled", "available", "known"],
  ]) {
    const { report } = JSON.parse(await readFile(new URL(`fixtures/capabilities/${name}.json`, root), "utf8"));
    assert.equal(validate(report), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const variants = report.actions.screenshot.variants.filter((v: any) => v.mode === "screen");
    assert.equal(variants.length, 2, name);
    const png = variants.find((v: any) => v.limits.parameters.format.values.includes("png"));
    const jpeg = variants.find((v: any) => v.limits.parameters.format.values.includes("jpg"));
    assert.equal(png.state, "available", name);
    assert.deepEqual(png.limits.parameters.format.values, ["png"], name);
    assert.equal(jpeg.state, state, name);
    assert.deepEqual(jpeg.limits.parameters.format.values, ["jpg"], name);
    assert.equal(jpeg.limits.parameters.format.knowledge, knowledge, name);
    const availableFormats = variants.filter((v: any) => v.state === "available").flatMap((v: any) => v.limits.parameters.format.values);
    assert.deepEqual(availableFormats, state === "available" ? ["png", "jpg"] : ["png"], name);
    const buildEvidence = report.actions.screenshot.evidence.find((e: any) => e.scope.startsWith("grim-jpeg-encoding-build-support;"));
    assert.equal(buildEvidence.status, knowledge === "unknown" ? "unknown" : state === "available" ? "passed" : "failed", name);
  }
});
