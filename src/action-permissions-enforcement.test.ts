import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../index.js";
import { COMPUTER_USE_AGENT, COMPUTER_USE_HEALTH_CHECK } from "./computer-use-agent.js";
import { COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME } from "./tool-names.js";
import { resolveActionPermissions } from "./action-permissions.js";
import { createComputerUseTool, createDesktopUseTool } from "./plugin-tool.js";
import { ProcessFailure } from "./process-runner.js";
import { type ComputerUseAuditEvent } from "./computer-use-audit.js";

function register(pluginConfig: unknown, contexts: object[] = [{}]) {
  const factories: any[] = []; let hook: any;
  plugin.register({ pluginConfig, registerTool: (factory: any) => factories.push(factory), on: (_: string, handler: any) => hook = handler } as never);
  return { factories, hook, tools: () => factories.flatMap(factory => contexts.map(context => factory(context))) };
}
const deniedRequests = [
  { action: "shell", command: process.execPath, args: ["-e", "process.exit(99)"] },
  { action: "file-write", path: "forbidden.txt", content: "sensitive-fixture" },
  { action: "clipboard-read" }, { action: "clipboard-write", clipboardText: "sensitive-fixture" },
  { action: "browser-open", url: "https://example.invalid" }, { action: "app-launch", app: "fixture" },
  { action: "permissions" }, { action: "see" }, { action: "capture" },
  { action: "type", text: "sensitive-fixture" }, { action: "press", keys: ["tab"] }, { action: "health" },
];

test("executor denies canonical and every legacy action before effects even with confirm true", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "desktopuse-permissions-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const factory of [createComputerUseTool, createDesktopUseTool]) {
    const audit: ComputerUseAuditEvent[] = [];
    const tool = factory({ ctx: { workspaceDir: workspace }, actionPermissions: resolveActionPermissions({ allowedActions: [] }),
      runAdapter: async () => { assert.fail("Denied action reached desktop adapter"); }, appendAuditEvent: async event => { audit.push(event); } });
    for (const request of deniedRequests) {
      const result = await tool.execute(`denied-${request.action}`, { ...request, confirm: true });
      assert.equal(result.details.status, "blocked", request.action); assert.equal(result.details.success, false);
      assert.equal(result.details.code, "ACTION_PROFILE_DENIED", request.action);
      assert.equal(audit.at(-1)?.result.code, "ACTION_PROFILE_DENIED");
      assert.ok(!JSON.stringify(audit.at(-1)).includes("sensitive-fixture"));
    }
    await assert.rejects(tool.execute("malformed", { action: "type" }), /requires text/);
  }
  await assert.rejects(access(join(workspace, "forbidden.txt")), { code: "ENOENT" });
});

test("hook denies aliases and forbidden actions before target resolution or approval", async () => {
  for (const config of [{ allowedActions: [] }, { actionProfile: "observation-only" }]) {
    const { hook } = register(config);
    const requests = config.allowedActions ? deniedRequests : deniedRequests.slice(0, 6);
    for (const toolName of [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME]) for (const request of requests) {
      const result = await hook({ toolName, params: { ...request, confirm: true } }, {});
      assert.equal(result.block, true); assert.match(result.blockReason, /trusted.*action permissions/);
      assert.equal(result.requireApproval, undefined);
    }
    const malformed = await hook({ toolName: COMPUTER_USE_TOOL_NAME, params: { action: "file-write" } }, {});
    assert.equal(malformed.blockReason, "Invalid computer-use parameters.");
    assert.equal(await hook({ toolName: COMPUTER_USE_TOOL_NAME, params: { action: "stop" } }, {}), undefined);
  }
});

test("registration snapshot survives config mutation and both names retain ordinary approvals", async () => {
  const config = { actionProfile: "desktop-only", allowedActions: ["click"] };
  const { hook, tools } = register(config);
  config.allowedActions.push("shell"); config.actionProfile = "full";
  for (const tool of tools()) {
    assert.deepEqual(tool.parameters.properties.action.enum, ["stop", "click"]);
    const result = await hook({ toolName: tool.name, params: { action: "shell", command: process.execPath, confirm: true } }, {});
    assert.equal(result.block, true);
    const approval = await hook({ toolName: tool.name, params: { action: "click", on: "B1", confirm: true } }, {});
    assert.ok(approval.requireApproval); assert.equal(approval.params.confirm, true);
  }
  assert.throws(() => register({ actionProfile: "typo" }), /Invalid action permissions/);
});

test("factory rejects forged mutable snapshots and model-controlled permission fields", async () => {
  for (const factory of [createComputerUseTool, createDesktopUseTool]) {
    assert.throws(() => factory({ actionPermissions: { profile: "full", allowedActions: ["shell", "stop"], snapshotId: "forged" } } as any), /Invalid action permissions snapshot/);
    const tool = factory({ actionPermissions: resolveActionPermissions({ allowedActions: [] }), appendAuditEvent: async () => {} });
    await assert.rejects(tool.execute("forged-config", { action: "stop", actionProfile: "full" }), /Unknown computer-use parameter/);
    const stop = await tool.execute("no-adapter-stop", { action: "stop" });
    assert.equal(stop.details.status, "success"); assert.equal(stop.details.cancellationRequested, 0);
  }
});

test("Stop-only tool cancels same-scope work without crossing workspace or session", async () => {
  const context = { agentId: "fixture", sessionKey: "permissions-stop", workspaceDir: "/tmp/permissions-workspace" };
  let started!: () => void; const ready = new Promise<void>(resolve => started = resolve);
  const active = createComputerUseTool({ ctx: context, appendAuditEvent: async () => {}, runAdapter: async (_args, _params, signal) => {
    started(); await new Promise(resolve => signal!.addEventListener("abort", resolve, { once: true })); return { ok: false };
  } }).execute("active", { action: "inspect" });
  await ready;
  for (const ctx of [{ ...context, sessionKey: "other" }, { ...context, workspaceDir: "/tmp/other" }, {}]) {
    const stop = createDesktopUseTool({ ctx, actionPermissions: resolveActionPermissions({ allowedActions: [] }), appendAuditEvent: async () => {} });
    assert.equal((await stop.execute("other-stop", { action: "stop" })).details.cancellationRequested, 0);
  }
  const stop = createComputerUseTool({ ctx: context, actionPermissions: resolveActionPermissions({ allowedActions: [] }), appendAuditEvent: async () => {} });
  assert.equal((await stop.execute("same-stop", { action: "stop" })).details.cancellationRequested, 1);
  await active;
});

test("health-only skips its disabled doctor dependency without adapter dispatch or native repair hints", async () => {
  for (const factory of [createComputerUseTool, createDesktopUseTool]) for (const confirm of [false, true]) {
    const permissions = resolveActionPermissions({ allowedActions: ["health"] });
    const snapshot = JSON.stringify(permissions);
    const audit: ComputerUseAuditEvent[] = [];
    let calls = 0;
    const tool = factory({ actionPermissions: permissions,
      runAdapter: async () => { calls++; assert.fail("Disabled doctor probe reached adapter"); },
      appendAuditEvent: async event => { audit.push(event); } });
    const schema = JSON.stringify(tool.parameters);
    const health = await tool.execute("health-only", { action: "health", confirm, reason: "private-health-diagnostic" });
    assert.equal(calls, 0, "health must not invoke or retry a disabled doctor probe");
    assert.equal(health.details.status, "blocked");
    assert.equal(health.details.success, false);
    assert.equal(health.details.action, "health");
    assert.equal(health.details.code, "ACTION_PROFILE_DENIED");
    assert.match(String(health.details.reason), /doctor.*not run.*disabled.*trusted action permissions/i);
    assert.deepEqual(health.details.adapterProbe, { action: "doctor", status: "skipped", code: "ACTION_PROFILE_DENIED" });
    assert.deepEqual(health.details.agent, COMPUTER_USE_AGENT);
    assert.deepEqual(health.details.healthCheck, COMPUTER_USE_HEALTH_CHECK);
    assert.ok(typeof health.details.auditLog === "string");
    assert.deepEqual(health.details.actionPermissions, { scope: "adapter-eligibility", profile: "full", allowedActions: ["health", "stop"],
      snapshotId: permissions.snapshotId, gatewayAuthorization: "not-reported" });
    assert.equal(health.details.repairHints, undefined);
    assert.equal(health.details.permissionFlow, undefined);
    assert.doesNotMatch(JSON.stringify(health.details), /Screen Recording|Accessibility|COVEN_DESKTOP_USE_BIN|missing.*binary|ENOENT|private-health-diagnostic/);
    assert.deepEqual(audit[0]?.result, { status: "blocked", success: false, code: "ACTION_PROFILE_DENIED" });
    assert.equal(audit[0]?.action, "health");
    assert.ok(!JSON.stringify(audit).includes("private-health-diagnostic"));
    for (const action of ["doctor", "permissions"]) {
      const denied = await tool.execute(`denied-${action}`, { action, confirm });
      assert.equal(denied.details.code, "ACTION_PROFILE_DENIED");
      assert.equal(denied.details.action, "doctor");
    }
    assert.equal(calls, 0);
    assert.deepEqual(tool.parameters.properties.action.enum, ["health", "stop"]);
    assert.equal(JSON.stringify(tool.parameters), schema);
    assert.equal(JSON.stringify(permissions), snapshot);
    assert.ok(Object.isFrozen(permissions));
    assert.ok(Object.isFrozen(permissions.allowedActions));
    assert.deepEqual(JSON.parse(health.content[0].text), health.details);
  }
});

test("health with doctor enabled still probes doctor and reports its actual health outcome", async () => {
  for (const factory of [createComputerUseTool, createDesktopUseTool]) {
    const calls: { args: string[]; action: string }[] = [];
    const tool = factory({ actionPermissions: resolveActionPermissions({ allowedActions: ["health", "doctor"] }),
      runAdapter: async (args, params) => { calls.push({ args, action: params.action }); return { ok: true }; },
      appendAuditEvent: async () => {} });
    const health = await tool.execute("health-with-doctor", { action: "health" });
    assert.deepEqual(calls, [{ args: ["doctor"], action: "doctor" }]);
    assert.equal(health.details.status, "success");
    assert.equal(health.details.success, true);
    assert.equal(health.details.adapterProbe, undefined);
    assert.ok(Array.isArray(health.details.repairHints));
  }
});

test("permitted health keeps the doctor observation retry and cancellation behavior", async () => {
  for (const factory of [createComputerUseTool, createDesktopUseTool]) {
    const permissions = resolveActionPermissions({ allowedActions: ["health", "doctor"] });
    let attempts = 0;
    const retry = factory({ actionPermissions: permissions, appendAuditEvent: async () => {},
      runAdapter: async (args, params) => {
        assert.deepEqual(args, ["doctor"]); assert.equal(params.action, "doctor");
        return ++attempts === 1 ? { ok: false, code: "EAGAIN" } : { ok: true };
      } });
    assert.equal((await retry.execute("health-retry", { action: "health" })).details.status, "success");
    assert.equal(attempts, 2);
    let started!: () => void;
    const ready = new Promise<void>(resolve => started = resolve);
    const controller = new AbortController();
    let cancelledAttempts = 0;
    const cancellable = factory({ actionPermissions: permissions, appendAuditEvent: async () => {},
      runAdapter: async (_args, _params, signal) => {
        cancelledAttempts++; started();
        return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new ProcessFailure("CANCELLED")), { once: true }));
      } });
    const pending = cancellable.execute("health-cancel", { action: "health" }, controller.signal);
    await ready; controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.details.status, "cancelled");
    assert.equal((cancelled.details.result as { code: string }).code, "CANCELLED");
    assert.equal(cancelledAttempts, 1);
  }
});

test("Stop hook remains available with an ambiguous authenticated workspace", async () => {
  const context = { agentId: "fixture", sessionKey: "conflicting-workspaces" };
  const { tools, hook } = register({ allowedActions: [] }, [{ ...context, workspaceDir: "/tmp/a" }, { ...context, workspaceDir: "/tmp/b" }]);
  tools();
  for (const toolName of [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME]) assert.equal(await hook({ toolName, params: { action: "stop" } }, context), undefined);
});


test("factory keeps its validated permission snapshot when construction options change", async () => {
  const options = { actionPermissions: resolveActionPermissions({ allowedActions: [] }), appendAuditEvent: async () => {} };
  const tool = createComputerUseTool(options);
  options.actionPermissions = resolveActionPermissions();
  const result = await tool.execute("unchanged-ceiling", { action: "file-write", path: "disabled.txt", content: "fixture", confirm: true });
  assert.equal(result.details.code, "ACTION_PROFILE_DENIED");
  assert.deepEqual(tool.parameters.properties.action.enum, ["stop"]);
});
