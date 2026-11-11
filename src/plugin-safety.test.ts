import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseTool } from "./plugin-tool.js";

async function workspace(t: any) {
  const root = await mkdtemp(join(tmpdir(), "desktopuse-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inside = join(root, "workspace");
  await mkdir(inside);
  await writeFile(join(root, "private.txt"), "arbitrary-private-text");
  return { root, inside };
}

test("relative traversal requires approval before reading", async (t) => {
  const { inside } = await workspace(t);
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside }, appendAuditEvent: async () => {} });
  const result = await tool.execute("traversal", { action: "file-read", path: "../private.txt", includeText: true });
  assert.equal(result.details.status, "needsApproval");
  assert.ok(!JSON.stringify(result).includes("arbitrary-private-text"));
});

test("symlink reads require approval for canonical external target", async (t) => {
  const { root, inside } = await workspace(t);
  await symlink(join(root, "private.txt"), join(inside, "alias"));
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside }, appendAuditEvent: async () => {} });
  const result = await tool.execute("symlink", { action: "file-read", path: "alias", includeText: true });
  assert.equal(result.details.status, "needsApproval");
  assert.ok(!JSON.stringify(result).includes("arbitrary-private-text"));
});

test("file contents require includeText and audit failure is visible", async (t) => {
  const { inside } = await workspace(t);
  await writeFile(join(inside, "plain.txt"), "arbitrary-private-text");
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside }, appendAuditEvent: async () => { throw new Error("private-audit-error"); } });
  const result = await tool.execute("audit", { action: "file-read", path: "plain.txt" });
  assert.deepEqual(result.details.audit, { written: false, code: "AUDIT_WRITE_FAILED" });
  assert.ok(!JSON.stringify(result).includes("arbitrary-private-text"));
  assert.ok(!JSON.stringify(result).includes("private-audit-error"));
});

test("stop cancels active helper across instances in the same session", async (t) => {
  const { root, inside } = await workspace(t);
  const ready = join(root, "ready");
  const fixture = join(root, "adapter");
  await writeFile(fixture, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));setInterval(()=>{},1000);`, { mode: 0o700 });
  const previous = process.env.COVEN_DESKTOP_USE_BIN;
  process.env.COVEN_DESKTOP_USE_BIN = fixture;
  t.after(() => { if (previous === undefined) delete process.env.COVEN_DESKTOP_USE_BIN; else process.env.COVEN_DESKTOP_USE_BIN = previous; });
  const ctx = { workspaceDir: inside, sessionKey: "safety-stop" };
  const tool = createComputerUseTool({ ctx, appendAuditEvent: async () => {} });
  const active = tool.execute("active", { action: "click", coords: "1,1", confirm: true });
  for (let i = 0; i < 100; i++) { try { await readFile(ready); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
  const pid = Number(await readFile(ready, "utf8"));
  const other = createComputerUseTool({ ctx, appendAuditEvent: async () => {} });
  await other.execute("stop", { action: "stop" });
  const outcome = await Promise.race([active, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("active call was not cancelled")), 1500).unref())]);
  assert.equal(outcome.details.status, "cancelled");
  assert.throws(() => process.kill(pid, 0));
});

test("ordinary workspace file reads work through canonical workspace aliases", async (t) => {
  const { inside } = await workspace(t);
  await writeFile(join(inside, "plain.txt"), "test content");
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside }, appendAuditEvent: async () => {} });
  const result = await tool.execute("normal", { action: "file-read", path: "plain.txt", includeText: true });
  assert.equal(result.details.status, "success");
  assert.equal(result.details.text, "test content");
});

test("approved write under symlink parent uses the exact canonical external target", async (t) => {
  const { root, inside } = await workspace(t);
  await symlink(root, join(inside, "link"));
  const events: unknown[] = [];
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside }, appendAuditEvent: async event => { events.push(event); } });
  const result = await tool.execute("write", { action: "file-write", path: "link/new/leaf.txt", content: "private file contents", confirm: true });
  assert.equal(result.details.status, "success");
  assert.equal(await readFile(join(root, "new/leaf.txt"), "utf8"), "private file contents");
  assert.ok(!JSON.stringify(events).includes("private file contents"));
});

test("malformed adapter output is an error without private diagnostic text", async (t) => {
  const { root, inside } = await workspace(t);
  const fixture = join(root, "adapter-malformed");
  await writeFile(fixture, `#!${process.execPath}\nconsole.log('arbitrary-private-text');`, { mode: 0o700 });
  const previous = process.env.COVEN_DESKTOP_USE_BIN;
  process.env.COVEN_DESKTOP_USE_BIN = fixture;
  t.after(() => { if (previous === undefined) delete process.env.COVEN_DESKTOP_USE_BIN; else process.env.COVEN_DESKTOP_USE_BIN = previous; });
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside }, appendAuditEvent: async () => {} });
  const result = await tool.execute("malformed", { action: "doctor" });
  assert.equal(result.details.status, "error");
  assert.ok(!JSON.stringify(result).includes("arbitrary-private-text"));
});

test("gateway abort cancels owned helpers without stopping a different session", async (t) => {
  const { inside } = await workspace(t);
  const controller = new AbortController();
  const tool = createComputerUseTool({ ctx: { workspaceDir: inside, sessionKey: "gateway-abort" }, appendAuditEvent: async () => {} });
  const active = tool.execute("gateway", { action: "shell", confirm: true, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, controller.signal);
  controller.abort();
  const result = await active;
  assert.equal(result.details.status, "cancelled");
  const other = createComputerUseTool({ ctx: { workspaceDir: inside, sessionKey: "other-session" }, appendAuditEvent: async () => {} });
  const independent = await other.execute("independent", { action: "shell", confirm: true, command: process.execPath, args: ["-e", "process.stdout.write('okay')"] });
  assert.equal(independent.details.status, "success");
  assert.equal(independent.details.stdout, "okay");
});

test("typed-input backend diagnostics retain only safe outcome fields", async () => {
  const tool = createComputerUseTool({
    runAdapter: async () => ({ ok: false, backend: "peekaboo", args: ["arbitrary-private-text"], arbitraryBackendField: "arbitrary-private-text", code: "arbitrary-private-text", completedSteps: 1, failedStep: 1 }),
    appendAuditEvent: async () => {},
  });
  const result = await tool.execute("private-diagnostics", { action: "type-text", text: "arbitrary-private-text", confirm: true });
  assert.equal(result.details.status, "error");
  assert.equal((result.details.result as any).completedSteps, 1);
  assert.ok(!JSON.stringify(result).includes("arbitrary-private-text"));
});

test("explicit capture destinations require write approval before adapter execution", async t => {
  const {root,inside}=await workspace(t); const outside=join(root,"existing.png"); await writeFile(outside,"original");
  let calls=0;
  const tool=createComputerUseTool({ctx:{workspaceDir:inside},runAdapter:async()=>{calls++;return{ok:true};},appendAuditEvent:async()=>{}});
  for (const action of ["screenshot","inspect","capture","see"]) {
    const result=await tool.execute("capture-path",{action,path:outside});
    assert.equal(result.details.status,"needsApproval");
  }
  assert.equal(calls,0); assert.equal(await readFile(outside,"utf8"),"original");
});
