import assert from "node:assert/strict";
import test from "node:test";
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
