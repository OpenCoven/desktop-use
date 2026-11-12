import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planHostAction } from "./host-actions.js";
import { runProcess } from "./process-runner.js";

const installed = (names: string[]) => (name: string) => names.includes(name) ? `/tools/${name}` : undefined;
test("Linux clipboard selects native session tools without falling into XWayland", () => {
  assert.deepEqual(planHostAction("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, installed(["wl-paste", "xclip"]), { action: "clipboard-read" }), { file: "/tools/wl-paste", args: ["--no-newline", "--type", "text"] });
  assert.equal(planHostAction("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, installed(["xclip"]), { action: "clipboard-read" }).supported, false);
  assert.deepEqual(planHostAction("linux", { DISPLAY: ":0" }, installed(["xclip"]), { action: "clipboard-read" }), { file: "/tools/xclip", args: ["-selection", "clipboard", "-out"] });
  assert.deepEqual(planHostAction("linux", { DISPLAY: ":0" }, installed(["xsel"]), { action: "clipboard-read" }), { file: "/tools/xsel", args: ["--clipboard", "--output"] });
});
test("Linux launch only uses validated URLs or desktop ids", () => {
  assert.deepEqual(planHostAction("linux", { DISPLAY: ":0" }, installed(["xdg-open"]), { action: "browser-open", url: "https://example.com/a?q=$(false)" }), { file: "/tools/xdg-open", args: ["https://example.com/a?q=$(false)"], capture: false, retainGroupOnSuccess: true });
  for (const url of ["--help", "javascript:alert(1)", "-a", "file:///tmp/private", "https://user:password@example.com"]) {
    assert.equal(planHostAction("linux", { DISPLAY: ":0" }, installed(["xdg-open"]), { action: "browser-open", url }).supported, false);
  }
  assert.deepEqual(planHostAction("linux", { DISPLAY: ":0" }, installed(["gtk-launch"]), { action: "app-launch", app: "org.example.Fixture.desktop" }), { file: "/tools/gtk-launch", args: ["org.example.Fixture.desktop"], capture: false, retainGroupOnSuccess: true });
  assert.equal(planHostAction("linux", { DISPLAY: ":0" }, installed(["gtk-launch"]), { action: "app-launch", app: "--help" }).supported, false);
  assert.equal(planHostAction("win32", {}, installed(["xdg-open"]), { action: "browser-open", url: "https://example.com" }).supported, false);
  assert.equal(planHostAction("linux", {}, installed(["xdg-open"]), { action: "browser-open", url: "https://example.com" }).supported, false);
});
test("clipboard writes transfer private input through stdin and omit diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "desktopuse-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, "wl-copy");
  const receipt = join(root, "receipt");
  await writeFile(helper, `#!${process.execPath}\nlet text='';process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args:process.argv.slice(2),text})));`, { mode: 0o700 });
  for (const input of [{ clipboardText: "private clipboard $(false)" }, { text: "private clipboard $(false)" }]) {
    const plan = planHostAction("linux", { WAYLAND_DISPLAY: "wayland-0" }, name => name === "wl-copy" ? helper : undefined, { action: "clipboard-write", ...input });
    assert.ok(plan.file);
    const result = await runProcess(plan.file!, plan.args!, { ...plan, timeoutMs: 1000 });
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), { args: ["--type", "text/plain;charset=utf-8"], text: "private clipboard $(false)" });
  }
});
