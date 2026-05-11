import assert from "node:assert/strict";
import test from "node:test";
import { createComputerUseTool } from "./plugin-tool.js";

test("returns needsApproval for unapproved interactive actions without invoking the adapter", async () => {
  const calls: string[][] = [];
  const audits: unknown[] = [];
  const tool = createComputerUseTool({
    ctx: {
      agentId: "computer-use",
      agentDir: "/tmp/openclaw/agents/computer-use/agent",
      workspaceDir: "/tmp/openclaw/workspace/computer-use",
      sessionKey: "agent:computer-use:main",
    },
    runAdapter: async (args) => {
      calls.push(args);
      return { ok: true };
    },
    appendAuditEvent: async (event) => {
      audits.push(event);
    },
  });

  const result = await tool.execute("tool-call-1", { action: "click", on: "B1" });

  assert.equal(calls.length, 0);
  assert.equal(result.details.status, "needsApproval");
  assert.equal(result.details.risk, "local-nondestructive");
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as { result: { status: string } }).result.status, "needsApproval");
});

test("passes approved desktop input through the adapter with --confirm", async () => {
  const calls: string[][] = [];
  const tool = createComputerUseTool({
    ctx: {
      agentId: "computer-use",
      workspaceDir: "/tmp/openclaw/workspace/computer-use",
      sessionKey: "agent:computer-use:main",
    },
    runAdapter: async (args) => {
      calls.push(args);
      return { ok: true, backend: "peekaboo" };
    },
    appendAuditEvent: async () => undefined,
  });

  const result = await tool.execute("tool-call-2", {
    action: "click",
    on: "B1",
    confirm: true,
  });

  assert.deepEqual(calls[0], ["click", "--confirm", "--on", "B1"]);
  assert.equal(result.details.status, "success");
  assert.equal(result.details.success, true);
});

test("retries transient observation adapter failures once", async () => {
  const calls: string[][] = [];
  const tool = createComputerUseTool({
    ctx: {
      agentId: "computer-use",
      workspaceDir: "/tmp/openclaw/workspace/computer-use",
      sessionKey: "agent:computer-use:main",
    },
    runAdapter: async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { ok: false, error: "ETIMEDOUT while observing frontmost window" }
        : { ok: true, backend: "peekaboo" };
    },
    appendAuditEvent: async () => undefined,
  });

  const result = await tool.execute("tool-call-observe-retry", {
    action: "inspect",
    mode: "frontmost",
  });

  assert.equal(calls.length, 2);
  assert.equal(result.details.status, "success");
  assert.equal(result.details.success, true);
});

test("does not retry transient failures for approved interactive desktop input", async () => {
  const calls: string[][] = [];
  const tool = createComputerUseTool({
    ctx: {
      agentId: "computer-use",
      workspaceDir: "/tmp/openclaw/workspace/computer-use",
      sessionKey: "agent:computer-use:main",
    },
    runAdapter: async (args) => {
      calls.push(args);
      return { ok: false, error: "ETIMEDOUT while clicking" };
    },
    appendAuditEvent: async () => undefined,
  });

  const result = await tool.execute("tool-call-input-no-retry", {
    action: "click",
    on: "B1",
    confirm: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(result.details.status, "error");
  assert.equal(result.details.success, false);
});

test("records a safe stop action without invoking machine-control adapters", async () => {
  const calls: string[][] = [];
  const audits: unknown[] = [];
  const tool = createComputerUseTool({
    ctx: {
      agentId: "computer-use",
      workspaceDir: "/tmp/openclaw/workspace/computer-use",
      sessionKey: "agent:computer-use:main",
    },
    runAdapter: async (args) => {
      calls.push(args);
      return { ok: true };
    },
    appendAuditEvent: async (event) => {
      audits.push(event);
    },
  });

  const result = await tool.execute("tool-call-stop", { action: "stop" });

  assert.equal(calls.length, 0);
  assert.equal(result.details.status, "success");
  assert.equal(result.details.action, "stop");
  assert.equal(audits.length, 1);
});

test("blocks dangerous shell attempts before adapter or host execution", async () => {
  const tool = createComputerUseTool({
    ctx: {
      agentId: "computer-use",
      workspaceDir: "/tmp/openclaw/workspace/computer-use",
      sessionKey: "agent:computer-use:main",
    },
    runAdapter: async () => {
      throw new Error("adapter should not run");
    },
    appendAuditEvent: async () => undefined,
  });

  const result = await tool.execute("tool-call-3", {
    action: "shell",
    command: "sudo",
    args: ["rm", "-rf", "/"],
  });

  assert.equal(result.details.status, "blocked");
  assert.match(result.details.reason ?? "", /privileged/i);
});
