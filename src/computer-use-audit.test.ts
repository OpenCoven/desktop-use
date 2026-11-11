import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { appendComputerUseAuditEvent, resolveComputerUseAuditLogPath, buildComputerUseAuditEvent } from "./computer-use-audit.js";
import { classifyComputerUseRequest } from "./computer-use-policy.js";

test("audit events redact sensitive params and summarize results", () => {
  const request = {
    action: "clipboard-write" as const,
    clipboardText: "secret clipboard",
    confirm: true,
  };
  const decision = classifyComputerUseRequest(request, { agentId: "computer-use" });
  const event = buildComputerUseAuditEvent({
    toolCallId: "call-1",
    request,
    decision,
    result: { status: "success", success: true },
    ctx: { agentId: "computer-use", sessionKey: "agent:computer-use:main" },
    now: new Date("2026-05-09T00:00:00.000Z"),
  });

  assert.equal(event.timestamp, "2026-05-09T00:00:00.000Z");
  assert.equal(event.agentId, "computer-use");
  assert.equal(event.action, "clipboard-write");
  assert.equal(event.result.status, "success");
  assert.match(event.resultHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(event), /secret clipboard/);
  assert.match(JSON.stringify(event), /<16-byte text>/);
});

test("durable audit never stores arbitrary private argv, URLs, paths, or reasons", () => {
  const request = { action: "shell" as const, command: "echo", args: ["arbitrary-private-value"], reason: "arbitrary-private-reason", path: "/tmp/arbitrary-private-path", url: "https://user:arbitrary-private-password@example.com" };
  const event = buildComputerUseAuditEvent({ request, decision: classifyComputerUseRequest(request), result: { status: "success" } });
  assert.doesNotMatch(JSON.stringify(event), /arbitrary-private/);
});

test("gateway calls without agentDir audit within the configured disposable state and agent", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktopuse-audit-state-"));
  const previous = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const ctx = { agentId: "isolated-agent", sessionKey: "audit-fixture" };
  const target = join(root, "agents/isolated-agent/audit/computer-use.jsonl");
  assert.equal(resolveComputerUseAuditLogPath(ctx), target);
  const request = { action: "stop" as const };
  const event = buildComputerUseAuditEvent({ request, ctx, decision: classifyComputerUseRequest(request, ctx), result: { status: "success" } });
  assert.deepEqual(await appendComputerUseAuditEvent(event, ctx), { path: target, written: true });
  assert.equal(JSON.parse((await readFile(target, "utf8")).trim()).agentId, "isolated-agent");
  assert.equal(resolveComputerUseAuditLogPath({ agentDir: join(root, "explicit/agent") }), join(root, "explicit/audit/computer-use.jsonl"));
  for (const agentId of ["../outside", "/absolute", "nested/agent", "..", ""]) {
    assert.throws(() => resolveComputerUseAuditLogPath({ agentId }));
  }
});
