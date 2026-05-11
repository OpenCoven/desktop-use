import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyComputerUseRequest,
  normalizeAdapterResult,
  redactComputerUseValue,
} from "./computer-use-policy.js";

const WORKSPACE = "/tmp/opencoven-computer-use-workspace";

test("allows observation actions without approval", () => {
  const decision = classifyComputerUseRequest(
    { action: "inspect", mode: "frontmost" },
    { workspaceDir: WORKSPACE, agentId: "computer-use" },
  );

  assert.equal(decision.status, "allow");
  assert.equal(decision.risk, "observe");
  assert.equal(decision.requiresApproval, false);
  assert.equal(decision.approvalPrompt, undefined);
});

test("requires approval for interactive desktop input and describes the target", () => {
  const decision = classifyComputerUseRequest(
    { action: "click", on: "B1", app: "Safari" },
    { workspaceDir: WORKSPACE, agentId: "computer-use" },
  );

  assert.equal(decision.status, "needsApproval");
  assert.equal(decision.risk, "local-nondestructive");
  assert.equal(decision.requiresApproval, true);
  assert.match(decision.approvalPrompt?.title ?? "", /Click/);
  assert.match(decision.approvalPrompt?.description ?? "", /Safari/);
  assert.match(decision.approvalPrompt?.description ?? "", /B1/);
});

test("blocks attempts to bypass macOS security boundaries", () => {
  const decision = classifyComputerUseRequest(
    {
      action: "shell",
      command: "tccutil",
      args: ["reset", "Accessibility"],
    },
    { workspaceDir: WORKSPACE, agentId: "computer-use" },
  );

  assert.equal(decision.status, "blocked");
  assert.equal(decision.risk, "privileged");
  assert.match(decision.reason ?? "", /security boundary/i);
});

test("allows read-only shell commands but approval-gates package installs", () => {
  const readOnly = classifyComputerUseRequest(
    { action: "shell", command: "git", args: ["status", "--short"] },
    { workspaceDir: WORKSPACE, agentId: "computer-use" },
  );
  assert.equal(readOnly.status, "allow");
  assert.equal(readOnly.risk, "local-nondestructive");

  const installer = classifyComputerUseRequest(
    { action: "shell", command: "npm", args: ["install", "-g", "some-package"] },
    { workspaceDir: WORKSPACE, agentId: "computer-use" },
  );
  assert.equal(installer.status, "needsApproval");
  assert.equal(installer.risk, "privileged");
  assert.match(installer.approvalPrompt?.description ?? "", /npm install -g some-package/);
});

test("approval-gates file writes outside the workspace", () => {
  const decision = classifyComputerUseRequest(
    {
      action: "file-write",
      path: "/Users/buns/.ssh/config",
      content: "Host example\n  HostName example.com\n",
    },
    { workspaceDir: WORKSPACE, agentId: "computer-use" },
  );

  assert.equal(decision.status, "needsApproval");
  assert.equal(decision.risk, "secret-sensitive");
  assert.match(decision.approvalPrompt?.description ?? "", /outside the configured workspace/i);
  assert.doesNotMatch(JSON.stringify(decision), /HostName example\.com/);
});

test("redacts typed text, clipboard text, and token-like values", () => {
  const redacted = redactComputerUseValue({
    action: "type-text",
    text: "hello",
    clipboardText: "secret clipboard",
    token: "sk-live-1234567890",
    nested: { password: "hunter2" },
  });

  assert.deepEqual(redacted, {
    action: "type-text",
    text: "<5-byte text>",
    clipboardText: "<16-byte text>",
    token: "<redacted>",
    nested: { password: "<redacted>" },
  });
});

test("normalizes adapter envelopes to structured result statuses", () => {
  assert.deepEqual(
    normalizeAdapterResult({ ok: true, stdout: "done" }, { evidence: { action: "doctor" } }),
    {
      status: "success",
      success: true,
      evidence: { action: "doctor" },
      result: { ok: true, stdout: "done" },
    },
  );

  assert.deepEqual(
    normalizeAdapterResult(
      { ok: false, supported: false, message: "unsupported" },
      { evidence: { action: "browser-open" } },
    ),
    {
      status: "unsupported",
      success: false,
      evidence: { action: "browser-open" },
      result: { ok: false, supported: false, message: "unsupported" },
    },
  );
});
