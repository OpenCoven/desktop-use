import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readRegularFile, writeRegularFile, listDirectory } from "./file-actions.js";

async function fixture(t: any) { const root = await mkdtemp(join(tmpdir(), "desktopuse-files-")); t.after(() => rm(root, {recursive:true,force:true})); return root; }
test("text reads reject FIFOs without waiting for a writer", async t => {
  const root = await fixture(t); const path = join(root,"fifo"); execFileSync("mkfifo",[path]);
  await assert.rejects(readRegularFile(path, undefined, Date.now()+1000), (e: any) => e.code === "NOT_REGULAR_FILE");
});
test("text reads bound allocation and reject files larger than 1 MiB", async t => {
  const root = await fixture(t); const path = join(root,"large"); await writeFile(path,Buffer.alloc(1024*1024+1));
  await assert.rejects(readRegularFile(path, undefined, Date.now()+1000), (e: any) => e.code === "FILE_TOO_LARGE");
});
test("cancelled writes never publish and existing files require overwrite", async t => {
  const root = await fixture(t); const path = join(root,"file"); const controller = new AbortController(); controller.abort();
  await assert.rejects(writeRegularFile(path,"private content",false,controller.signal,Date.now()+1000), (e: any) => e.code === "CANCELLED");
  await assert.rejects(readFile(path),{code:"ENOENT"});
  await writeRegularFile(path,"first",false,undefined,Date.now()+1000);
  await assert.rejects(writeRegularFile(path,"second",false,undefined,Date.now()+1000),{code:"EEXIST"});
  assert.equal(await readFile(path,"utf8"),"first");
  await writeRegularFile(path,"second",true,undefined,Date.now()+1000);
  assert.equal(await readFile(path,"utf8"),"second");
});
test("file writes reject FIFOs and directory listings stop at 500 entries", async t => {
  const root = await fixture(t); const fifo = join(root,"fifo"); execFileSync("mkfifo",[fifo]);
  await assert.rejects(writeRegularFile(fifo,"text",true,undefined,Date.now()+1000),(e:any)=>e.code==="NOT_REGULAR_FILE");
  const directory=join(root,"list"); await mkdir(directory);
  await Promise.all(Array.from({length:505},(_,i)=>writeFile(join(directory,String(i)),"")));
  const result=await listDirectory(directory,undefined,Date.now()+1000);
  assert.equal(result.entries.length,500); assert.equal(result.truncated,true);
});

for (const overwrite of [false, true]) test(`committed ${overwrite ? "rename" : "link"} remains successful with visible staging cleanup failure`, async t => {
  const root = await fixture(t); const path = join(root, "published");
  const originalRm = fs.rm;
  const fault = mock.method(fs, "rm", async (target: any, options: any) => {
    if (String(target).includes(".desktopuse-write-")) {
      assert.equal(await readFile(path, "utf8"), "published bytes");
      throw new Error("private staging cleanup diagnostics");
    }
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    const outcome = await writeRegularFile(path, "published bytes", overwrite, undefined, Date.now() + 1000);
    assert.equal((outcome as any)?.cleanup.code, "TEMPORARY_CLEANUP_FAILED");
    assert.deepEqual((outcome as any).cleanup.stages, ["file-write-staging"]);
    assert.equal(JSON.stringify(outcome).includes("private staging cleanup diagnostics"), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

test("precommit failure keeps its code and exposes staging cleanup failure", async t => {
  const root = await fixture(t); const path = join(root, "existing"); await writeFile(path, "previous");
  const originalRm = fs.rm;
  const fault = mock.method(fs, "rm", async (target: any, options: any) => {
    if (String(target).includes(".desktopuse-write-")) throw new Error("private staging cleanup diagnostics");
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeRegularFile(path, "replacement", false, undefined, Date.now() + 1000), (error: any) => {
      assert.equal(error.code, "EEXIST");
      assert.equal(error.cleanup.code, "TEMPORARY_CLEANUP_FAILED");
      assert.equal(error.message.includes("private staging cleanup diagnostics"), false);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), "previous");
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

test("file-write tool preserves committed outcome and reports cleanup limitation without audit content", async t => {
  const root = await fs.realpath(await fixture(t)); const path = join(root, "published");
  const { createComputerUseTool } = await import("./plugin-tool.js");
  const audits: unknown[] = [];
  const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const, appendAuditEvent: async event => { audits.push(event); } });
  const originalRm = fs.rm;
  const fault = mock.method(fs, "rm", async (target: any, options: any) => {
    if (String(target).includes(".desktopuse-write-")) throw new Error("private staging cleanup diagnostics");
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    const result = await tool.execute("file-write-cleanup", { action: "file-write", path, content: "private output bytes", confirm: true });
    assert.equal(result.details.status, "success");
    assert.equal(await readFile(path, "utf8"), "private output bytes");
    assert.equal((result.details.cleanup as any).code, "TEMPORARY_CLEANUP_FAILED");
    assert.equal(JSON.stringify(result).includes("private staging cleanup diagnostics"), false);
    assert.equal(JSON.stringify(audits).includes("private output bytes"), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
