import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createComputerUseTool } from "./plugin-tool.js";
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../contracts/v1/fixtures/capabilities/${name}.json`, import.meta.url), "utf8")).report;

test("healthy doctor health omits false missing-adapter and macOS grant instructions", async () => {
  const tool = createComputerUseTool({ runAdapter: async () => ({ ok: true, platform: "linux", capabilitiesV1: await fixture("x11"), setupGuide: { installCommand: "sudo apt install scrot xdotool wmctrl", missingTools: [] } }), appendAuditEvent: async () => {} });
  const { details } = await tool.execute("healthy", { action: "health" });
  assert.equal(details.status, "success");
  assert.deepEqual(details.repairHints, []);
  assert.equal((details.capabilitiesV1 as any).producer.surface, "plugin");
  assert.equal(details.permissionFlow, undefined);
});

test("health interprets successful macOS permission queries as evidence, never as grants", async () => {
  for (const [name, extra, denied] of [
    ["macos-permission-denied", {}, true],
    ["macos", { backend: "peekaboo", result: { success: true, data: { permissions: [{ name: "Screen Recording", isGranted: false }] } } }, true],
    ["macos-permission-granted", {}, false],
    ["macos", {}, false],
  ] as const) {
    const tool = createComputerUseTool({ runAdapter: async () => ({ ok: true, platform: "macos", capabilitiesV1: await fixture(name), ...extra }), appendAuditEvent: async () => {} });
    const { details } = await tool.execute(`permission-${name}`, { action: "health" });
    assert.equal(details.status, "success");
    assert.equal(JSON.stringify(details.repairHints).includes("Screen Recording"), denied);
    assert.equal(Boolean(details.permissionFlow), denied);
    assert.doesNotMatch(JSON.stringify(details.repairHints), /adapter.*not found/i);
  }
});

test("adapter-reported ENOENT is not a missing adapter and audit failure preserves health outcome", async () => {
  for (const name of ["missing-helper", "x11-empty", "wayland-unknown", "wayland-unavailable", "headless", "windows"]) {
    const tool = createComputerUseTool({ runAdapter: async () => ({ ok: false, code: "ENOENT", platform: name === "missing-helper" ? "macos" : "linux", capabilitiesV1: await fixture(name), setupGuide: { missingTools: ["scrot"], installCommand: "sudo apt install scrot" } }), appendAuditEvent: async () => { throw new Error("private audit diagnostics"); } });
    const { details } = await tool.execute(name, { action: "health" });
    assert.equal(details.status, "error");
    assert.equal((details.adapterInvocation as any).phase, "adapter");
    assert.deepEqual(details.audit, { written: false, code: "AUDIT_WRITE_FAILED" });
    assert.doesNotMatch(JSON.stringify(details.repairHints), /selected adapter could not|COVEN_DESKTOP_USE_BIN|Screen Recording|Accessibility/);
    if (name === "missing-helper") assert.match(JSON.stringify(details.repairHints), /Peekaboo/);
    if (name === "x11-empty") assert.match(JSON.stringify(details.repairHints), /setupGuide/);
    if (["wayland-unknown", "wayland-unavailable"].includes(name)) assert.equal((details.capabilitiesV1 as any).actions["type-text"].evidence.some((e: any) => e.kind === "actual-action" && e.status === "passed"), false);
    assert.doesNotMatch(JSON.stringify(details), /private audit diagnostics/);
  }
  const success = await createComputerUseTool({ runAdapter: async () => ({ ok: true, capabilitiesV1: await fixture("x11") }), appendAuditEvent: async () => { throw new Error("private"); } }).execute("audit", { action: "health" });
  assert.equal(success.details.status, "success");
  assert.deepEqual(success.details.repairHints, []);
  assert.deepEqual(success.details.audit, { written: false, code: "AUDIT_WRITE_FAILED" });
});

test("schema incompatibility is visible while local Stop and file implementation survive", async () => {
  for (const major of [2, "1", null]) {
    const adapter = await fixture("x11"); adapter.schemaVersion = major;
    const { details } = await createComputerUseTool({ runAdapter: async () => ({ ok: true, capabilitiesV1: adapter }), appendAuditEvent: async () => {} }).execute("schema", { action: "health" });
    assert.equal(details.status, "error");
    assert.equal(details.code, "CAPABILITY_SCHEMA_UNSUPPORTED");
    assert.equal((details.capabilitiesV1 as any).actions.stop.state, "available");
    assert.equal((details.capabilitiesV1 as any).actions["file-read"].state, "available");
    assert.equal((details.capabilitiesV1 as any).actions.screenshot.state, "unverified");
    assert.match(JSON.stringify(details.repairHints), /schema v1/);
  }
});

test("plugin doctor exposes trusted plugin eligibility and preserves legacy adapter fields", async () => {
  const { resolveActionPermissions } = await import("./action-permissions.js");
  const report = await fixture("x11");
  const tool = createComputerUseTool({ actionPermissions: resolveActionPermissions({ actionProfile: "observation-only" }), runAdapter: async () => ({ ok: true, platform: "linux", capabilitiesV1: report, legacyInventory: { scrot: true } }), appendAuditEvent: async () => {} });
  const { details } = await tool.execute("doctor-profile", { action: "doctor" });
  assert.equal(details.status, "success");
  assert.equal(details.action, "doctor");
  assert.deepEqual((details.result as any).legacyInventory, { scrot: true });
  const capabilities = details.capabilitiesV1 as any;
  assert.equal(capabilities?.producer.surface, "plugin");
  assert.equal(capabilities.actions.shell.policy.profile, "denied");
  assert.equal(capabilities.actions.stop.state, "available");
  assert.equal(capabilities.actions.screenshot.policy.approval, "request-dependent");
  assert.deepEqual(details.repairHints, []);
});
