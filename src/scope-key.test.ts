import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../index.js";
import type { ComputerUsePolicyContext } from "./computer-use-policy.js";
import { createComputerUseTool } from "./plugin-tool.js";
import { ProcessFailure } from "./process-runner.js";
import { COMPUTER_USE_TOOL_NAME } from "./tool-names.js";

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
