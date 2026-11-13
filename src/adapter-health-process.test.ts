import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseTool } from "./plugin-tool.js";

test("real adapter spawn/output provenance distinguishes absent/nonexecutable adapters from helper ENOENT", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktopuse-health-"));
  const original = process.env.COVEN_DESKTOP_USE_BIN;
  try {
    const healthy = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/capabilities/x11.json", import.meta.url), "utf8")).report;
    for (const [name, body, executable, phase, code, hint] of [
      ["absent", undefined, false, "spawn", "ENOENT", /COVEN_DESKTOP_USE_BIN/],
      ["denied", "#!/bin/sh\nexit 0\n", false, "spawn", "EACCES", /executable access/],
      ["malformed", `#!${process.execPath}\nconsole.log('private-invalid-output')\n`, true, "output", "MALFORMED_OUTPUT", /malformed/],
      ["helper", `#!${process.execPath}\nconsole.log(JSON.stringify({ok:false,code:'ENOENT',backend:'x11',platform:'linux',capabilitiesV1:${JSON.stringify(healthy)}}))\n`, true, "adapter", "ENOENT", /^\[\]$/],
      ["healthy", `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,capabilitiesV1:${JSON.stringify(healthy)}}))\n`, true, "adapter", undefined, /^\[\]$/],
    ] as const) {
      const path = join(root, name);
      if (body !== undefined) await writeFile(path, body, { mode: executable ? 0o700 : 0o600 });
      process.env.COVEN_DESKTOP_USE_BIN = path;
      const { details } = await createComputerUseTool({ appendAuditEvent: async () => {} }).execute(name, { action: "health" });
      assert.equal((details.adapterInvocation as any).phase, phase, name);
      assert.equal((details.adapterInvocation as any).code, code, name);
      assert.match(JSON.stringify(details.repairHints), hint, name);
      assert.doesNotMatch(JSON.stringify(details), /private-invalid-output|Screen Recording|Accessibility/);
      assert.equal((details.capabilitiesV1 as any).actions.stop.state, "available");
      if (name === "healthy") {
        const link = join(root, "selected-link"); await symlink(path, link); process.env.COVEN_DESKTOP_USE_BIN = link;
        const selected = await createComputerUseTool({ appendAuditEvent: async () => {} }).execute("selected", { action: "health" });
        assert.equal((selected.details.adapterInvocation as any).configuredPath, link);
        assert.equal((selected.details.adapterInvocation as any).resolvedPath, await realpath(path));
        assert.equal((selected.details.adapterInvocation as any).version, "0.1.3");
      }
    }
  } finally {
    if (original === undefined) delete process.env.COVEN_DESKTOP_USE_BIN; else process.env.COVEN_DESKTOP_USE_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("real adapter post-start timeout, output limit and cancellation retain execution provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktopuse-health-lifecycle-")); const previous = process.env.COVEN_DESKTOP_USE_BIN;
  try {
    for (const [name, body, expectedCode, expectedStatus] of [
      ["timeout", "setInterval(()=>{},1000)", "ETIMEDOUT", "timeout"],
      ["output", "process.stdout.write('x'.repeat(11*1024*1024));setInterval(()=>{},1000)", "OUTPUT_LIMIT", "error"],
      ["cancel", `require('fs').writeFileSync(${JSON.stringify(join(root,"ready"))},'ready');setInterval(()=>{},1000)`, "CANCELLED", "cancelled"],
    ] as const) {
      const path=join(root,name); await writeFile(path,`#!${process.execPath}\n${body}\n`,{mode:0o700}); process.env.COVEN_DESKTOP_USE_BIN=path;
      const controller=new AbortController(); const pending=createComputerUseTool({appendAuditEvent:async()=>{}}).execute(name,{action:"health",timeoutMs:1000},controller.signal);
      if(name==="cancel") { for(let tries=0;;tries++){if(await readFile(join(root,"ready"),"utf8").catch(()=>"")==="ready")break;assert.ok(tries<80);await new Promise(r=>setTimeout(r,10));} controller.abort(); }
      const {details}=await pending; assert.equal(details.status,expectedStatus); assert.equal((details.adapterInvocation as any).phase,"process"); assert.equal((details.adapterInvocation as any).processStarted,true); assert.equal((details.adapterInvocation as any).code,expectedCode); assert.doesNotMatch(JSON.stringify(details.repairHints),/malformed|schema v1|could not be started|Screen Recording/);
    }
    const aborted=new AbortController();aborted.abort();const {details}=await createComputerUseTool({appendAuditEvent:async()=>{}}).execute("prestart",{action:"health"},aborted.signal);
    assert.equal((details.adapterInvocation as any)?.phase,"before-start");assert.equal((details.adapterInvocation as any)?.processStarted,false);
  } finally {if(previous===undefined)delete process.env.COVEN_DESKTOP_USE_BIN;else process.env.COVEN_DESKTOP_USE_BIN=previous;await rm(root,{recursive:true,force:true});}
});
