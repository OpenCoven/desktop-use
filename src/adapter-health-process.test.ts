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
        assert.equal((selected.details.adapterInvocation as any).version, "0.1.2");
      }
    }
  } finally {
    if (original === undefined) delete process.env.COVEN_DESKTOP_USE_BIN; else process.env.COVEN_DESKTOP_USE_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});
