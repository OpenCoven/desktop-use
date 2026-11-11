import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "./process-runner.js";

const node = process.execPath;
test("helper runner preserves literal argv", async () => {
  const result = await runProcess(node, ["-e", "process.stdout.write(process.argv[1])", "--", "$(touch /nope); `false` 'quoted'"], { timeoutMs: 1000 });
  assert.equal(result.stdout, "$(touch /nope); `false` 'quoted'");
});
test("helper error does not echo argv or output", async () => {
  await assert.rejects(runProcess(node, ["-e", "process.stderr.write(process.argv[1]);process.exit(1)", "private-text"], { timeoutMs: 1000 }), (error: any) => {
    assert.equal(error.code, "PROCESS_EXIT");
    assert.doesNotMatch(JSON.stringify(error) + String(error), /private-text/);
    return true;
  });
});
test("timeout bounds a TERM-ignoring helper", async () => {
  const start = Date.now();
  await assert.rejects(runProcess(node, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 100 }), (e: any) => e.code === "ETIMEDOUT");
  assert.ok(Date.now() - start < 1500);
});
test("abort terminates active helper", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(runProcess(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 1000, signal: controller.signal }), (e: any) => e.code === "CANCELLED");
});
test("missing helper yields a bounded safe error", async () => {
  await assert.rejects(runProcess("/no/such/private-text", [], { timeoutMs: 1000 }), (e: any) => e.code === "ENOENT" && !String(e).includes("private-text"));
});

test("timeout removes inherited-pipe descendants after the parent exits", async (t) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "desktopuse-descendant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "should-not-exist");
  const script = `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'leaked'),600);`)}],{stdio:['ignore',1,2]}).unref();`;
  await assert.rejects(runProcess(node, ["-e", script], { timeoutMs: 100 }), (e: any) => e.code === "ETIMEDOUT");
  await new Promise(r => setTimeout(r, 650));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
