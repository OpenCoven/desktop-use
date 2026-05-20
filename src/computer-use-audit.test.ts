import assert from "node:assert/strict";
import test from "node:test";
import { buildComputerUseAuditEvent } from "./computer-use-audit.js";
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
