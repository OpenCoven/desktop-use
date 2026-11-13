// Synthetic discovery envelopes only; this wrapper never performs desktop input.
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
export async function createCapabilitiesFixture(repo, root, fallbackAdapter) {
  const marker = join(root, "capability-envelope.json");
  const adapter = join(root, "capability-adapter.cjs");
  const parked = `${adapter}.parked`;
  await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='doctor'&&fs.existsSync(${JSON.stringify(marker)})){process.stdout.write(fs.readFileSync(${JSON.stringify(marker)}));process.exit(0);}const child=cp.spawnSync(${JSON.stringify(fallbackAdapter)},args,{encoding:'utf8',env:process.env});process.stdout.write(child.stdout||'');process.exit(child.status??1);\n`, { mode: 0o700 });
  return { adapter, marker,
    async select(name) {
      if (name === "missing-adapter") { await rename(adapter, parked); return; }
      const { report } = JSON.parse(await readFile(join(repo, `contracts/v1/fixtures/capabilities/${name === "schema-unknown" ? "x11" : name}.json`), "utf8"));
      if (name === "schema-unknown") report.schemaVersion = 99;
      await writeFile(marker, JSON.stringify({ ok: name !== "missing-helper", ...(name === "missing-helper" ? { code: "ENOENT" } : {}), platform: report.environment.platform, session: report.environment.session, capabilitiesV1: report, ...(name === "x11-empty" ? { setupGuide: { missingTools: ["scrot", "xdotool", "wmctrl"], installCommand: "sudo apt install scrot xdotool wmctrl" } } : {}) }), { mode: 0o600 });
    },
    async restore() { await rename(parked, adapter).catch(error => { if (error.code !== "ENOENT") throw error; }); await rm(marker, { force: true }); },
  };
}
