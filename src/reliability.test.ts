import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseTool } from "./plugin-tool.js";

const invalid = [
  null, [], { action: 1 }, { action: "unknown" },
  { action: "doctor", unexpected: true },
  { action: "click", confirm: "true" },
  { action: "shell", command: ["echo"] },
  { action: "shell", command: "echo", args: [1] },
  { action: "keypress", keys: ["a\0b"] },
  { action: "shell", command: "echo\0" },
  { action: "doctor", timeoutMs: 0 },
  { action: "doctor", timeoutMs: Infinity },
  { action: "doctor", timeoutMs: 120001 },
  { action: "scroll", amount: 51 },
  { action: "scroll", amount: 1.5 },
  { action: "screenshot", screenIndex: -1 },
  { action: "screenshot", mode: "invalid" },
  { action: "keypress", keys: Array(257).fill("a") },
  { action: "keypress", keys: ["a".repeat(1024), "b".repeat(1024)] },
  { action: "shell", command: "echo", args: ["é".repeat(1025)] },
  { action: "inspect", app: "é".repeat(1025) },
];
for (const [index, params] of invalid.entries()) {
  test(`rejects malformed request ${index} before any adapter call`, async () => {
    let called = false;
    const tool = createComputerUseTool({
      runAdapter: async () => { called = true; return { ok: true }; },
      appendAuditEvent: async () => undefined,
    });
    await assert.rejects(tool.execute("invalid", params), { name: "ToolInputError" });
    assert.equal(called, false);
  });
}

test("actual adapter envelopes control action status, retries, and durable audit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-reliability-"));
  const executable = join(dir, "adapter");
  const receipt = join(dir, "calls.jsonl");
  const previous = process.env.COVEN_DESKTOP_USE_BIN;
  try {
    process.env.COVEN_DESKTOP_USE_BIN = executable;
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const, ctx: { agentDir: join(dir, "agent") } });
    for (const [payload, action, expected, count] of [
      [{ ok: true }, "doctor", "success", 1],
      [{ ok: false, error: "backend failed" }, "doctor", "error", 1],
      [{ ok: false, supported: false }, "doctor", "unsupported", 1],
      [{ ok: false, requiresConfirmation: true }, "doctor", "needsApproval", 1],
      ["invalid JSON", "doctor", "error", 1],
      [null, "doctor", "error", 1],
      [{ ok: false, error: "ETIMEDOUT" }, "inspect", "error", 2],
      [{ ok: false, error: "ETIMEDOUT" }, "click", "error", 1],
      [{ ok: false, error: "PERMISSION_ERROR_SCREEN_RECORDING" }, "inspect", "error", 1],
    ] as const) {
      await writeFile(receipt, "");
      const output = typeof payload === "string" ? payload : JSON.stringify(payload);
      await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(${JSON.stringify(output)});\n`, { mode: 0o700 });
      const result = await tool.execute(`fixture-${expected}`, {
        action, ...(action === "click" ? { on: "B1", confirm: true } : {}),
      });
      assert.equal(result.details.status, expected);
      assert.equal(result.details.success, expected === "success");
      const calls = (await readFile(receipt, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(calls.length, count);
      const argv = calls[0].slice(0, -2);
      if (action === "inspect") {
        assert.equal(argv.at(-2), "--path");
        assert.match(argv.at(-1), /desktopuse-observation-[^/]+\/primary.image$/);
        argv.splice(-2);
      }
      assert.deepEqual(argv, action === "click" ? ["click", "--confirm", "--on", "B1"] : [action]);
      assert.equal(calls[0].at(-2), "--timeout-ms");
    }
    const events = (await readFile(join(dir, "audit/computer-use.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 9);
    assert.equal(events[1].result.status, "error");
  } finally {
    if (previous === undefined) delete process.env.COVEN_DESKTOP_USE_BIN;
    else process.env.COVEN_DESKTOP_USE_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("filesystem execution failure returns a structured error and writes a real audit record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-error-"));
  try {
    const tool = createComputerUseTool({ ctx: { workspaceDir: dir, agentDir: join(dir, "agent") } });
    const result = await tool.execute("missing", { action: "file-read", path: "missing.txt" });
    assert.equal(result.details.status, "error");
    assert.equal(result.details.code, "ENOENT");
    const event = JSON.parse(await readFile(join(dir, "audit/computer-use.jsonl"), "utf8"));
    assert.equal(event.result.status, "error");
    assert.equal(event.result.code, "ENOENT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed audit append preserves the completed file-write and exposes failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-audit-"));
  try {
    const auditRoot = join(dir, "not-a-directory");
    await writeFile(auditRoot, "block audit directory creation");
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const, ctx: { workspaceDir: dir, agentDir: auditRoot } });
    const result = await tool.execute("write", { action: "file-write", path: "output", content: "private content", confirm: true });
    assert.equal(result.details.status, "success");
    assert.deepEqual(result.details.audit, { written: false, code: "AUDIT_WRITE_FAILED" });
    assert.equal(await readFile(join(dir, "output"), "utf8"), "private content");
    assert.doesNotMatch(JSON.stringify(result), /private content/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adapter exceptions are audited without exposing typed text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-thrown-"));
  try {
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const,
      ctx: { agentDir: join(dir, "agent") },
      runAdapter: async () => { throw new Error("Command failed: type-text --text private input"); },
    });
    const result = await tool.execute("thrown", { action: "type-text", text: "private input", confirm: true });
    assert.equal(result.details.status, "error");
    assert.equal(result.details.code, "ACTION_FAILED");
    const audit = await readFile(join(dir, "audit/computer-use.jsonl"), "utf8");
    assert.equal(JSON.parse(audit).params.text, "<13-byte text>");
    assert.doesNotMatch(JSON.stringify(result) + audit, /private input/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("valid UTF-8 limits and literal argv are preserved", async () => {
  const calls: string[][] = [];
  const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const,
    runAdapter: async (args) => { calls.push(args); return { ok: true }; },
    appendAuditEvent: async () => undefined,
  });
  const text = "é".repeat(50_000);
  const result = await tool.execute("boundary", { action: "type-text", text, confirm: true });
  assert.equal(result.details.status, "success");
  assert.deepEqual(calls[0], ["type-text", "--confirm", "--text", text]);
  await assert.rejects(tool.execute("oversize", { action: "type-text", text: text + "é", confirm: true }), { name: "ToolInputError" });
  const app = "é".repeat(1024);
  await tool.execute("arg-boundary", { action: "inspect", app });
  assert.deepEqual(calls[1].slice(0, -2), ["inspect", "--app", app]);
  assert.equal(calls[1].at(-2), "--path");
  assert.match(calls[1].at(-1)!, /desktopuse-observation-[^/]+\/primary.image$/);
});

test("failed adapter process does not echo typed text from process diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-process-error-"));
  const executable = join(dir, "adapter");
  const previous = process.env.COVEN_DESKTOP_USE_BIN;
  try {
    await writeFile(executable, '#!/usr/bin/env node\nconsole.error(process.argv.at(-1)); process.exit(1);\n', { mode: 0o700 });
    process.env.COVEN_DESKTOP_USE_BIN = executable;
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const, ctx: { agentDir: join(dir, "agent") } });
    const result = await tool.execute("failed-input", { action: "type-text", text: "private typed input", confirm: true });
    assert.equal(result.details.status, "error");
    assert.doesNotMatch(JSON.stringify(result), /private typed input/);
    assert.doesNotMatch(await readFile(join(dir, "audit/computer-use.jsonl"), "utf8"), /private typed input/);
  } finally {
    if (previous === undefined) delete process.env.COVEN_DESKTOP_USE_BIN;
    else process.env.COVEN_DESKTOP_USE_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual observation process timeout exhausts the shared budget without retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-timeout-"));
  const executable = join(dir, "adapter");
  const receipt = join(dir, "calls");
  const previous = process.env.COVEN_DESKTOP_USE_BIN;
  try {
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)}, 'called\\n');\nsetTimeout(() => {}, 10000);\n`, { mode: 0o700 });
    process.env.COVEN_DESKTOP_USE_BIN = executable;
    const tool = createComputerUseTool({ appendAuditEvent: async () => undefined });
    const result = await tool.execute("timeout", { action: "inspect", timeoutMs: 1000 });
    assert.equal(result.details.status, "timeout");
    assert.equal((await readFile(receipt, "utf8")).trim().split("\n").length, 1);
  } finally {
    if (previous === undefined) delete process.env.COVEN_DESKTOP_USE_BIN;
    else process.env.COVEN_DESKTOP_USE_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("exit-zero backend errors redact nested typed-input diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-use-backend-error-"));
  const executable = join(dir, "adapter");
  const previous = process.env.COVEN_DESKTOP_USE_BIN;
  try {
    const payload = { ok: false, backend: "peekaboo", stderr: "private typed input", stdout: "private typed input", error: "private typed input", steps: [{ stderr: "private typed input" }] };
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(payload))}); console.error('private typed input');\n`, { mode: 0o700 });
    process.env.COVEN_DESKTOP_USE_BIN = executable;
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const, ctx: { agentDir: join(dir, "agent") } });
    const result = await tool.execute("backend-error", { action: "type-text", text: "private typed input", confirm: true });
    assert.equal(result.details.status, "error");
    assert.doesNotMatch(JSON.stringify(result), /private typed input/);
    assert.doesNotMatch(await readFile(join(dir, "audit/computer-use.jsonl"), "utf8"), /private typed input/);
  } finally {
    if (previous === undefined) delete process.env.COVEN_DESKTOP_USE_BIN;
    else process.env.COVEN_DESKTOP_USE_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

for (const params of [
  { action: "click", on: "B1" },
  { action: "type-text", text: "hello" },
  { action: "keypress", keys: ["tab"] },
  { action: "scroll", direction: "down" },
  { action: "focus", app: "fixture-app" },
  { action: "type", text: "hello" },
  { action: "press", keys: ["tab"] },
]) {
  test(`does not replay ${params.action} after a backend timeout`, async () => {
    let calls = 0;
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const,
      runAdapter: async () => { calls++; return { ok: false, error: "ETIMEDOUT" }; },
      appendAuditEvent: async () => undefined,
    });
    const result = await tool.execute("input-once", { ...params, confirm: true });
    assert.equal(result.details.status, "error");
    assert.equal(calls, 1);
  });
}
