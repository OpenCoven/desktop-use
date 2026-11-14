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

test("runner reports explicit pre-start and spawn-failed lifecycle facts", async () => {
  const aborted = new AbortController(); aborted.abort();
  for (const [file, options, code, lifecycle] of [
    [node, { timeoutMs: 1000, signal: aborted.signal }, "CANCELLED", "not-started"],
    [node, { timeoutMs: 0 }, "ETIMEDOUT", "not-started"],
    ["/no/such/lifecycle-helper", { timeoutMs: 1000 }, "ENOENT", "spawn-failed"],
  ] as const) await assert.rejects(runProcess(file, [], options), (e: any) => { assert.equal(e.code, code); assert.equal(e.lifecycle, lifecycle); return true; });
});

test("runner retains started provenance for timeout, output, stdin and nonzero failures", async () => {
  for (const [script, options, code] of [
    ["setInterval(()=>{},1000)", { timeoutMs: 100 }, "ETIMEDOUT"],
    ["process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)", { timeoutMs: 1000, maxBuffer: 100 }, "OUTPUT_LIMIT"],
    ["require('fs').closeSync(0);setInterval(()=>{},1000)", { timeoutMs: 1000, input: "x".repeat(4*1024*1024) }, "STDIN_ERROR"],
    ["process.exit(2)", { timeoutMs: 1000 }, "PROCESS_EXIT"],
  ] as const) await assert.rejects(runProcess(node, ["-e", script], options), (e: any) => { assert.equal(e.code, code); assert.equal(e.lifecycle, "started"); assert.doesNotMatch(String(e), /repeat|stdin.destroy/); return true; });
});

test("runner distinguishes cancellation after observed child readiness", async t => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "desktopuse-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "ready"); const controller = new AbortController();
  const pending = runProcess(node, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`], { timeoutMs: 2000, signal: controller.signal }); pending.catch(() => {});
  for (let tries=0;;tries++) { if (await readFile(marker,"utf8").catch(()=>"") === "ready") break; assert.ok(tries < 100); await new Promise(r=>setTimeout(r,10)); }
  controller.abort(); await assert.rejects(pending, (e:any) => { assert.equal(e.code,"CANCELLED"); assert.equal(e.lifecycle,"started"); return true; });
});
