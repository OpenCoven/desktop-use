import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { buildPluginCapabilities, discoverCapabilityControls, repairHintsForCapabilities, type HostEvidence } from "./capabilities.js";
import { resolveActionPermissions } from "./action-permissions.js";
import { createComputerUseTool } from "./plugin-tool.js";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../contracts/v1/fixtures/capabilities/${name}.json`, import.meta.url), "utf8")).report;
const host: HostEvidence = { environment: { platform: "linux", session: null }, adapter: { configuredPath: "coven-desktop-use", resolvedPath: "/fixture/adapter" }, integrations: {}, observedAtMs: 1700000000001 };
const permissions = resolveActionPermissions();


test("plugin normalization preserves every fixture and overlays only trusted action authority", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/v1/capabilities.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020.default({ strict: true }).compile(schema);
  for (const name of await readdir(new URL("../contracts/v1/fixtures/capabilities/", import.meta.url))) {
    const report = await fixture(name.replace(/\.json$/, ""));
    const before = structuredClone(report);
    const result = buildPluginCapabilities({ capabilitiesV1: report }, host, permissions);
    assert.equal(validate(result), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(report, before);
    assert.deepEqual(result.actions.screenshot.variants, report.actions.screenshot.variants);
    assert.equal(result.actions["file-read"].state, "available");
    assert.equal(result.actions.stop.state, "available");
    assert.equal(result.actions.click.policy.profile, "allowed");
    assert.equal(result.actions.screenshot.policy.approval, "request-dependent");
    assert.equal(result.actions["file-read"].policy.approval, "request-dependent");
    assert.equal(result.actions.shell.policy.approval, "required");
    assert.equal(result.actions.click.policy.gatewayPolicy, "not-reported");
    assert.ok(!result.actions.click.surfaces.includes("sdk"));
    assert.equal(result.adapter?.resolvedPath, "/fixture/adapter");
    assert.equal(result.adapter?.version, "0.1.2");
    assert.equal(result.actionPermissions?.snapshotId, permissions.snapshotId);
  }
});

test("malformed and unknown contracts fail visibly instead of being interpreted as v1", async () => {
  const good = await fixture("wayland-advertised");
  for (const mutate of [
    (r: any) => { r.schemaVersion = 2; },
    (r: any) => { delete r.actions["type-text"]; },
    (r: any) => { r.actions.click.variants[0].selectors = ["window-title"]; },
    (r: any) => { r.actions.click.policy.gatewayPolicy = "allowed"; },
    (r: any) => { r.actions.click.surfaces.push("private"); },
    (r: any) => { r.actions.click.variants[0].limits.parameters.amount = { maximum: Infinity }; },
    (r: any) => { r.extra = "private"; },
  ]) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => buildPluginCapabilities({ capabilitiesV1: bad }, host, permissions), /CAPABILITY_SCHEMA_(UNSUPPORTED|INVALID)/);
  }
  assert.throws(() => buildPluginCapabilities({}, host, { ...permissions }), /snapshot/);
});

test("Stop-only eligibility leaves backend support separate and discovery disables every other control", async () => {
  const result = buildPluginCapabilities({ capabilitiesV1: await fixture("x11") }, host, resolveActionPermissions({ allowedActions: [] }));
  assert.equal(result.actions.screenshot.state, "available");
  assert.equal(result.actions.screenshot.policy.profile, "denied");
  const controls = discoverCapabilityControls(result);
  assert.deepEqual(controls.filter(control => control.enabled).map(control => control.action), ["stop"]);
  assert.ok(controls.find(control => control.action === "screenshot")!.reasonCodes.includes("ACTION_PROFILE_DENIED"));
  let calls = 0;
  const tool = createComputerUseTool({ actionPermissions: resolveActionPermissions({ allowedActions: [] }), runAdapter: async () => { calls++; }, appendAuditEvent: async () => {} });
  assert.equal((await tool.execute("denied-health", { action: "health" })).details.code, "ACTION_PROFILE_DENIED");
  assert.equal(calls, 0);
});

test("consumer keeps separate format/mode/selectors and surfaces unknown reasons without platform branches", async () => {
  for (const name of ["wayland-advertised", "wayland-grim-jpeg-disabled", "wayland-grim-jpeg-enabled", "headless", "windows", "macos"]) {
    const report = buildPluginCapabilities({ capabilitiesV1: await fixture(name) }, host, permissions);
    const screenshot = discoverCapabilityControls(report).find(control => control.action === "screenshot")!;
    const png = screenshot.variants.find(variant => variant.parameters.format?.values?.includes("png"));
    const jpeg = screenshot.variants.find(variant => variant.parameters.format?.values?.includes("jpg"));
    if (name.startsWith("wayland")) {
      assert.equal(png?.enabled, true);
      assert.equal(jpeg?.enabled, name === "wayland-grim-jpeg-enabled");
      assert.ok(jpeg?.enabled || jpeg!.reasonCodes.length > 0);
      assert.deepEqual(png?.selectors, []);
    }
    if (["headless", "windows"].includes(name)) assert.equal(screenshot.enabled, false);
    assert.equal(discoverCapabilityControls(report).find(control => control.action === "file-read")?.enabled, true);
  }
});

test("repair guidance follows failure phase and matching permission/protocol evidence", async () => {
  const report = (name: string) => fixture(name).then(capabilitiesV1 => buildPluginCapabilities({ capabilitiesV1 }, host, permissions));
  const healthy = await report("macos-permission-granted");
  assert.deepEqual(repairHintsForCapabilities(healthy, { phase: "adapter", code: "ENOENT" }), []);
  assert.match(repairHintsForCapabilities(healthy, { phase: "spawn", code: "ENOENT" }).join(" "), /adapter.*COVEN_DESKTOP_USE_BIN/i);
  assert.doesNotMatch(repairHintsForCapabilities(healthy, { phase: "spawn", code: "EACCES" }).join(" "), /Screen Recording|not found/);
  assert.match(repairHintsForCapabilities(await report("macos-permission-denied"), { phase: "adapter" }).join(" "), /Screen Recording/);
  for (const name of ["wayland-unknown", "wayland-unavailable", "headless", "windows"]) {
    assert.doesNotMatch(repairHintsForCapabilities(await report(name), { phase: "adapter" }).join(" "), /Screen Recording|Accessibility|binary not found/);
  }
  assert.match(repairHintsForCapabilities(await report("x11-empty"), { phase: "adapter", setupGuide: true }).join(" "), /setupGuide/);
});

test("host variants disclose request limits and installed integrations remain unverified", () => {
  const report = buildPluginCapabilities(undefined, { ...host, integrations: { "clipboard-write": { state: "unverified", reasonCodes: ["HOST_ACCESS_UNVERIFIED"], provider: { name: "wl-copy", version: null } } } }, permissions);
  const controls = discoverCapabilityControls(report);
  assert.equal(controls.find(c => c.action === "file-write")!.variants[0].parameters.content.maxBytes, 100000);
  assert.equal(controls.find(c => c.action === "file-read")!.variants[0].parameters.file.maxBytes, 1048576);
  assert.equal(controls.find(c => c.action === "shell")!.variants[0].parameters.command.maxBytes, 2048);
  assert.equal(controls.find(c => c.action === "clipboard-write")!.enabled, false);
  assert.equal(report.actions["clipboard-write"].evidence.find(e => e.kind === "binary")?.status, "passed");
  assert.equal(report.actions["clipboard-write"].evidence.find(e => e.kind === "actual-action")?.status, "not-run");
});

test("runtime schema validation agrees with shared validator for nested mutation failures", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/v1/capabilities.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020.default({ strict: true }).compile(schema);
  const original = await fixture("x11");
  const mutations = [
    (r: any) => { r.actions.click.state = "ready"; },
    (r: any) => { r.actions.click.surfaces = ["plugin", "plugin"]; },
    (r: any) => { r.actions.click.reasonCodes = ["raw diagnostics"]; },
    (r: any) => { r.actions.click.evidence = []; },
    (r: any) => { r.actions.click.evidence[0].status = "verified"; },
    (r: any) => { r.actions.click.evidence[0].observedAtMs = -1; },
    (r: any) => { r.actions.click.variants[0].mode = "auto"; },
    (r: any) => { r.actions.click.variants[0].provider = { name: "xdotool" }; },
    (r: any) => { r.actions.click.variants[0].provider.private = "raw"; },
    (r: any) => { r.actions.click.variants[0].limits.parameters.x = { values: [] }; },
    (r: any) => { r.actions.click.variants[0].limits.parameters.x = { values: [1, 1] }; },
    (r: any) => { r.actions.click.variants[0].limits.parameters.x = { maxBytes: -1 }; },
    (r: any) => { r.actions.click.variants[0].limits.parameters.x = { maxWidth: 0 }; },
    (r: any) => { r.actions.click.variants[0].limits.parameters.x = { knowledge: "assumed" }; },
    (r: any) => { r.environment.session = "gnome"; },
    (r: any) => { r.producer.version = ""; },
    (r: any) => { r.actionPermissions = { ...permissions, allowedActions: ["press"] }; },
  ];
  for (const mutate of mutations) {
    const report = structuredClone(original); mutate(report);
    assert.equal(validate(report), false, JSON.stringify(report));
    assert.throws(() => buildPluginCapabilities({ capabilitiesV1: report }, host, permissions), /CAPABILITY_SCHEMA_INVALID/);
  }
});

test("consumer never enables a variant when its parent action is unsupported", async () => {
  const report = buildPluginCapabilities({ capabilitiesV1: await fixture("x11") }, host, permissions);
  report.actions.screenshot.state = "unsupported";
  report.actions.screenshot.reasonCodes = ["SURFACE_UNAVAILABLE"];
  const control = discoverCapabilityControls(report).find(c => c.action === "screenshot")!;
  assert.equal(control.enabled, false);
  assert.ok(control.variants.every(variant => !variant.enabled));
});

test("an unsupported host session does not claim a failed plugin binary probe", () => {
  const report = buildPluginCapabilities(undefined, { ...host, integrations: { "clipboard-read": { state: "unsupported", reasonCodes: ["HOST_PREREQUISITE_UNAVAILABLE"] } } }, permissions);
  const evidence = report.actions["clipboard-read"].evidence.find(e => e.kind === "binary")!;
  assert.equal(evidence.status, "unknown");
  assert.equal(evidence.provider, undefined);
});
