import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { buildPluginCapabilities, discoverCapabilityControls, repairHintsForCapabilities, type HostEvidence } from "./capabilities.js";
import { resolveActionPermissions } from "./action-permissions.js";
import { createComputerUseTool, normalizeParams } from "./plugin-tool.js";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../contracts/v1/fixtures/capabilities/${name}.json`, import.meta.url), "utf8")).report;
const host: HostEvidence = { environment: { platform: "linux", session: null }, adapter: { configuredPath: "coven-desktop-use", resolvedPath: "/fixture/adapter" }, integrations: {}, observedAtMs: 1700000000001 };
const permissions = resolveActionPermissions();


test("plugin normalization preserves backend facts and overlays trusted authority plus request bounds", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/v1/capabilities.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020.default({ strict: true }).compile(schema);
  for (const name of await readdir(new URL("../contracts/v1/fixtures/capabilities/", import.meta.url))) {
    const report = await fixture(name.replace(/\.json$/, ""));
    const before = structuredClone(report);
    const result = buildPluginCapabilities({ capabilitiesV1: report }, host, permissions);
    assert.equal(validate(result), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(report, before);
    for (const [index, variant] of result.actions.screenshot.variants.entries()) {
      const source = report.actions.screenshot.variants[index];
      assert.deepEqual({ ...variant, limits: undefined }, { ...source, limits: undefined });
      assert.deepEqual(variant.limits.constraints, source.limits.constraints);
      for (const [name, limit] of Object.entries(source.limits.parameters)) assert.deepEqual(variant.limits.parameters[name], limit);
    }
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
  const report = buildPluginCapabilities(undefined, { ...host, integrations: { "clipboard-write": { state: "unverified", reasonCodes: ["HOST_ACCESS_UNVERIFIED"], provider: { name: "wl-copy", version: null }, binary: { status: "passed", observedAtMs: 1700000000001 } } } }, permissions);
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

test("planned Mac provider identity cannot assert a successful executable observation", async () => {
  const { planHostAction } = await import("./host-actions.js");
  const plan = planHostAction("darwin", {}, () => undefined, { action: "clipboard-read" });
  assert.equal(plan.file, "/usr/bin/pbpaste");
  const report = buildPluginCapabilities(undefined, { ...host, integrations: { "clipboard-read": { state: "unverified", reasonCodes: ["HOST_ACCESS_UNVERIFIED"], provider: { name: "pbpaste", version: null } } } }, permissions);
  const binary = report.actions["clipboard-read"].evidence.find(e=>e.kind==="binary")!;
  assert.equal(binary.status,"unknown"); assert.equal(binary.observedAtMs,undefined); assert.equal(binary.provider?.name,"pbpaste");
});


test("plugin controls disclose enforced UTF-8 text, selector, path, key collection and scroll bounds", async () => {
  for (const name of ["x11", "wayland-advertised", "wayland-unknown", "macos"]) {
    const cli = await fixture(name);
    const before = structuredClone(cli);
    const report = buildPluginCapabilities({ capabilitiesV1: cli }, host, permissions);
    const controls = discoverCapabilityControls(report);
    const variants = (action: string) => controls.find(c => c.action === action)!.variants;
    for (const variant of variants("type-text")) {
      assert.equal(variant.parameters.text?.maxBytes, 100000);
      if (variant.provider.name === "ydotool") assert.equal(variant.parameters.text.encoding, "ascii");
    }
    for (const variant of variants("screenshot")) {
      assert.equal(variant.parameters.path.maxBytes, 2048);
      assert.equal(Boolean(variant.parameters.app), variant.selectors.includes("app"));
      if (variant.selectors.includes("app")) assert.equal(variant.parameters.app.maxBytes, 2048);
    }
    for (const variant of variants("keypress")) {
      assert.equal(variant.parameters.keys.maxItems, 256);
      assert.equal(variant.parameters.keys.maxItemBytes, 2048);
      assert.equal(variant.parameters.keys.joined?.maxBytes, 2048);
      assert.equal(variant.parameters.keys.joined?.separator, ",");
    }
    for (const variant of variants("scroll")) assert.equal(variant.parameters.amount.maximum, 50);
    assert.deepEqual(cli, before, "plugin bounds must not modify CLI-relative reports");
  }
  for (const [good, bad] of [
    [{ action: "type-text", text: "é".repeat(50000) }, { action: "type-text", text: "é".repeat(50000) + "a" }],
    [{ action: "focus", app: "é".repeat(1024) }, { action: "focus", app: "é".repeat(1024) + "a" }],
    [{ action: "screenshot", path: "é".repeat(1024) }, { action: "screenshot", path: "é".repeat(1024) + "a" }],
    [{ action: "keypress", keys: Array(256).fill("a") }, { action: "keypress", keys: Array(257).fill("a") }],
    [{ action: "keypress", keys: ["é".repeat(1023), "a"] }, { action: "keypress", keys: ["é".repeat(1023), "aa"] }],
    [{ action: "scroll", direction: "down", amount: 50 }, { action: "scroll", direction: "down", amount: 51 }],
    [{ action: "shell", command: "echo", args: Array(256).fill("é".repeat(1024)) }, { action: "shell", command: "echo", args: ["é".repeat(1024) + "a"] }],
  ]) {
    assert.doesNotThrow(() => normalizeParams(good));
    assert.throws(() => normalizeParams(bad));
  }
  const local = buildPluginCapabilities(undefined, host, permissions);
  const shell = local.actions.shell.variants[0].limits.parameters;
  assert.equal(shell.args.maxItems, 256);
  assert.equal(shell.args.maxItemBytes, 2048);
  assert.equal(shell.args.joined, undefined, "shell argv has no joined total ceiling");
  assert.equal(shell.cwd.maxBytes, 2048);
});

test("plugin limit intersection retains stricter backend values, units, selectors and encodings", async () => {
  const cli = await fixture("wayland-unknown");
  cli.actions["type-text"].variants[1].limits.parameters.text.maxBytes = 128;
  cli.actions.scroll.variants[1].limits.parameters.amount = { minimum: 2, maximum: 7, units: "wheel-steps" };
  const report = buildPluginCapabilities({ capabilitiesV1: cli }, host, permissions);
  assert.deepEqual(report.actions["type-text"].variants[1].limits.parameters.text, { encoding: "ascii", maxBytes: 128 });
  assert.deepEqual(report.actions.scroll.variants[1].limits.parameters.amount, { minimum: 2, maximum: 7, units: "wheel-steps" });
  assert.deepEqual(report.actions["type-text"].variants[1].selectors, cli.actions["type-text"].variants[1].selectors);
});


test("runtime and independent schema validator agree on shared collection limits", async () => {
  const root = new URL("../contracts/v1/", import.meta.url);
  const schema = JSON.parse(await readFile(new URL("capabilities.schema.json", root), "utf8"));
  const samples = JSON.parse(await readFile(new URL("fixtures/collection-limits.json", root), "utf8"));
  const validate = new Ajv2020.default({ strict: true }).compile(schema);
  for (const [parameter, valid] of [[samples.valid, true], ...samples.invalid.map((value: unknown) => [value, false])]) {
    const cli = await fixture("macos");
    cli.actions.keypress.variants[0].limits.parameters.keys = parameter;
    assert.equal(validate(cli), valid, JSON.stringify(parameter));
    if (valid) {
      const controls = discoverCapabilityControls(buildPluginCapabilities({ capabilitiesV1: cli }, host, permissions));
      assert.deepEqual(controls.find(c => c.action === "keypress")!.variants[0].parameters.keys, samples.valid);
    } else assert.throws(() => buildPluginCapabilities({ capabilitiesV1: cli }, host, permissions), /CAPABILITY_SCHEMA_INVALID/);
  }
});


test("plugin coordinate and numeric bounds match validation without weakening X11 input bounds", async () => {
  const mac = buildPluginCapabilities({ capabilitiesV1: await fixture("macos") }, host, permissions);
  const coords = discoverCapabilityControls(mac).find(c => c.action === "click")!.variants[0].parameters.coords;
  assert.equal(coords.minimum, -2147483648);
  assert.equal(coords.maximum, 2147483647);
  const x11 = buildPluginCapabilities({ capabilitiesV1: await fixture("x11") }, host, permissions);
  assert.equal(x11.actions.click.variants[0].limits.parameters.coords.minimum, 0);
  assert.equal(x11.actions.click.variants[0].limits.parameters.coords.maximum, 32767);
  assert.doesNotThrow(() => normalizeParams({ action: "click", coords: "-2147483648,2147483647" }));
  assert.throws(() => normalizeParams({ action: "click", coords: "-2147483649,2147483647" }));
  assert.throws(() => normalizeParams({ action: "click", coords: "0,2147483648" }));
  for (const [property, minimum, maximum] of [["windowId", -9007199254740991, 9007199254740991], ["screenIndex", 0, 9007199254740991], ["timeoutMs", 1000, 120000]] as const) {
    const variant = mac.actions.screenshot.variants.find(v => v.selectors.includes(property)) ?? mac.actions.screenshot.variants[0];
    assert.equal(variant.limits.parameters[property].minimum, minimum);
    assert.equal(variant.limits.parameters[property].maximum, maximum);
    assert.doesNotThrow(() => normalizeParams({ action: "screenshot", [property]: minimum }));
    assert.doesNotThrow(() => normalizeParams({ action: "screenshot", [property]: maximum }));
    for (const bad of [minimum - 1, maximum + 1, 1.5, Infinity]) assert.throws(() => normalizeParams({ action: "screenshot", [property]: bad }));
  }
});
