import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../index.js";
import type { ComputerUsePolicyContext } from "./computer-use-policy.js";
import { createComputerUseTool } from "./plugin-tool.js";
import { ProcessFailure } from "./process-runner.js";
import { COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME } from "./tool-names.js";

type Hook = (event: unknown, ctx: ComputerUsePolicyContext) => Promise<{ params?: { path?: string } }>;

// Registers the plugin once and hands each tool factory every context, in order.
function hookFor(contexts: ComputerUsePolicyContext[]): Hook {
  let handler: Hook | undefined;
  plugin.register({
    id: "opencoven-desktop-use", name: "fixture", source: "test", registrationMode: "full",
    config: {}, runtime: {}, logger: console,
    registerTool(factory: (ctx: ComputerUsePolicyContext) => unknown) { for (const ctx of contexts) factory(ctx); },
    on(name: string, value: Hook) { if (name === "before_tool_call") handler = value; },
  } as never);
  return handler!;
}

// An adapter call that stays active until its AbortSignal fires.
function hangingTool(ctx: ComputerUsePolicyContext) {
  return createComputerUseTool({
    ctx,
    appendAuditEvent: async () => {},
    runAdapter: (_args, _params, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new ProcessFailure("CANCELLED")), { once: true });
    }),
  });
}

test("stop from a sessionless context leaves a session named \"default\" running", async () => {
  const workspaceDir = "/tmp/openclaw/workspace/scope-stop";
  const named = hangingTool({ agentId: "computer-use", sessionKey: "default", workspaceDir });
  const active = named.execute("active", { action: "doctor" });

  const sessionless = createComputerUseTool({ ctx: { agentId: "computer-use", workspaceDir }, appendAuditEvent: async () => {} });
  const stopped = await sessionless.execute("stop", { action: "stop" });
  const settled = await Promise.race([active.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 50))]);

  // Release the fixture call from its own session before asserting.
  const own = await named.execute("own-stop", { action: "stop" });
  await active;

  assert.equal(stopped.details.cancellationRequested, 0);
  assert.equal(stopped.details.state, "idle");
  assert.equal(settled, false, "another session's call must keep running");
  assert.equal(own.details.cancellationRequested, 1);
});

test("the approval hook keeps a sessionless context apart from an empty session key", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktopuse-scope-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);

  const hook = hookFor([
    { agentId: "computer-use", workspaceDir: first },
    { agentId: "computer-use", sessionKey: "", workspaceDir: second },
  ]);
  const event = (toolName: string) => ({ toolName, params: { action: "file-write", path: "note.txt", content: "fixture" } });

  const sessionless = await hook(event(COMPUTER_USE_TOOL_NAME), { agentId: "computer-use" });
  const empty = await hook(event(COMPUTER_USE_TOOL_NAME), { agentId: "computer-use", sessionKey: "" });

  assert.equal(sessionless.params?.path, join(first, "note.txt"));
  assert.equal(empty.params?.path, join(second, "note.txt"));
});

for (const toolName of [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME]) {
  test(`${toolName} file approval never borrows another session's factory context`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "desktopuse-missing-scope-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hook = hookFor([{ agentId: "computer-use", sessionKey: "known", workspaceDir: root }]);
    for (const ctx of [{}, { agentId: "computer-use", sessionKey: "other" }, { agentId: "other", sessionKey: "known" }]) {
      const result = await hook({ toolName, params: { action: "file-write", path: "note.txt", content: "fixture" } }, ctx) as any;
      assert.equal(result.block, true, JSON.stringify(ctx));
      assert.equal(result.params, undefined);
      assert.equal(result.requireApproval, undefined);
    }
  });
  test(`${toolName} file approval fails closed for conflicting workspaces in the same scope`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "desktopuse-ambiguous-scope-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = join(root, "first"), second = join(root, "second");
    await mkdir(first); await mkdir(second);
    const ctx = { agentId: "computer-use", sessionKey: "same" };
    const hook = hookFor([{ ...ctx, workspaceDir: first }, { ...ctx, workspaceDir: second }]);
    const result = await hook({ toolName, params: { action: "file-write", path: "note.txt", content: "fixture" } }, ctx) as any;
    assert.equal(result.block, true);
    assert.equal(result.params, undefined);
    assert.equal(result.requireApproval, undefined);
  });
}

test("Stop leaves different agents, sessions, and workspaces active", async () => {
  const own = { agentId: "computer-use", sessionKey: "shared", workspaceDir: "/tmp/owned-workspace" };
  const tool = hangingTool(own);
  const active = tool.execute("active-scopes", { action: "doctor" });
  for (const ctx of [
    { ...own, agentId: "another-agent" },
    { ...own, sessionKey: "another-session" },
    { ...own, workspaceDir: "/tmp/another-workspace" },
    { agentId: own.agentId },
  ]) {
    const result = await createComputerUseTool({ ctx, appendAuditEvent: async () => {} }).execute("unrelated-stop", { action: "stop" });
    assert.equal(result.details.cancellationRequested, 0);
  }
  const stopped = await tool.execute("own-stop", { action: "stop" });
  assert.equal(stopped.details.cancellationRequested, 1);
  assert.equal((await active).details.status, "cancelled");
});

for (const toolName of [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME]) {
  test(`${toolName} model-supplied confirmation still requires a gateway approval`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "desktopuse-model-confirm-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ctx = { agentId: "computer-use", sessionKey: "confirmed-input", workspaceDir: root };
    const hook = hookFor([ctx]);
    for (const params of [
      { action: "file-write", path: "note.txt", content: "fixture", confirm: true },
      { action: "click", coords: "1,1", confirm: true },
      { action: "shell", command: process.execPath, args: ["-e", "process.exit(0)"], confirm: true },
    ]) {
      const result = await hook({ toolName, params }, ctx) as any;
      assert.ok(result.requireApproval, params.action);
      assert.equal(result.requireApproval.timeoutBehavior, "deny");
      assert.equal(result.params?.confirm, true);
    }
  });
}

for (const toolName of [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME]) {
  test(`${toolName} shell approval requires its own authenticated workspace context`, async () => {
    const hook = hookFor([{ agentId: "computer-use", sessionKey: "known", workspaceDir: "/tmp/known-workspace" }]);
    const result = await hook({ toolName, params: { action: "shell", command: process.execPath, args: ["-e", "process.exit(0)"] } }, { agentId: "computer-use", sessionKey: "unknown" }) as any;
    assert.equal(result.block, true);
    assert.equal(result.requireApproval, undefined);
  });
}
