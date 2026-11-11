import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseTool, normalizeParams } from "./plugin-tool.js";

const noAudit = async () => {};

test("health exceptions never expose raw diagnostic strings", async () => {
  const audit: unknown[] = [];
  const tool = createComputerUseTool({ runAdapter: async () => { throw new Error("private-health-diagnostic"); }, appendAuditEvent: async e => { audit.push(e); } });
  const result = await tool.execute("health-error", { action: "health" });
  assert.equal(result.details.status, "error");
  assert.ok(!JSON.stringify([result, audit]).includes("private-health-diagnostic"));
});

test("failed shell processes never expose raw stdout, stderr or command diagnostics", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktopuse-review-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fixture");
  await writeFile(file, `#!${process.execPath}\nconsole.log('private-shell-diagnostic');console.error('private-shell-diagnostic');process.exit(1);`, { mode: 0o700 });
  const result = await createComputerUseTool({ appendAuditEvent: noAudit }).execute("shell-error", { action: "shell", command: file, confirm: true });
  assert.equal(result.details.status, "error");
  assert.ok(!JSON.stringify(result).includes("private-shell-diagnostic"));
});

for (const [payload, status] of [
  [{ ok: false, error: "rejected" }, "error"],
  [{ success: false, error: { code: "PERMISSION_ERROR" } }, "error"],
  [{ ok: false, supported: false }, "unsupported"],
  [{ ok: false, requiresConfirmation: true }, "needsApproval"],
  [{ success: true, data: {} }, "success"],
  ["malformed-private-output", "error"],
  [[], "error"],
] as const) {
  test(`Peekaboo nested stdout action determines ${status}: ${JSON.stringify(payload)}`, async () => {
    const tool = createComputerUseTool({ runAdapter: async () => ({ ok: true, adapter: "fixture", result: { ok: true, backend: "peekaboo", stdout: typeof payload === "string" ? payload : JSON.stringify(payload) } }), appendAuditEvent: noAudit });
    const result = await tool.execute("nested", { action: "inspect" });
    assert.equal(result.details.status, status);
  });
}

test("nested transient observation failure is retried but permission failure is not", async () => {
  for (const [error, count] of [["EAGAIN", 2], ["PERMISSION_ERROR", 1]] as const) {
    let calls = 0;
    const tool = createComputerUseTool({ runAdapter: async () => ({ ok: true, adapter: "fixture", result: { ok: true, backend: "peekaboo", stdout: JSON.stringify(++calls === 1 ? { success: false, error: { code: error } } : { success: true }) } }), appendAuditEvent: noAudit });
    const result = await tool.execute("retry", { action: "inspect" });
    assert.equal(calls, count);
    assert.equal(result.details.status, count === 2 ? "success" : "error");
  }
});

test("prototype fields cannot supply action or approval", async () => {
  assert.throws(() => normalizeParams(Object.create({ action: "click", on: "B1", confirm: true })), { name: "ToolInputError" });
  const request = Object.assign(Object.create({ confirm: true }), { action: "click", on: "B1" });
  const result = await createComputerUseTool({ runAdapter: async () => { throw new Error("unapproved runner"); }, appendAuditEvent: noAudit }).execute("own", request);
  assert.equal(result.details.status, "needsApproval");
  assert.throws(() => normalizeParams({ action: "keypress", keys: Array(2) }), { name: "ToolInputError" });
});

export const missingArguments = [
  { action: "click" }, { action: "type-text" }, { action: "keypress" },
  { action: "keypress", keys: [""] }, { action: "scroll" }, { action: "focus" },
  { action: "shell" }, { action: "file-read" }, { action: "file-write", path: "file" },
  { action: "clipboard-write" }, { action: "browser-open" }, { action: "app-launch" },
];
for (const params of missingArguments) {
  test(`action argv is validated before policy: ${JSON.stringify(params)}`, async () => {
    const tool = createComputerUseTool({ appendAuditEvent: async () => { throw new Error("invalid input must not reach audit"); }, runAdapter: async () => { throw new Error("invalid input must not execute"); } });
    await assert.rejects(tool.execute("invalid-args", params), { name: "ToolInputError" });
  });
}
