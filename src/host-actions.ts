import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { HostEvidence } from "./capabilities.js";
import type { ComputerUseParams } from "./computer-use-policy.js";

export type HostPlan = {
  file?: string;
  args?: string[];
  input?: string;
  capture?: boolean;
  retainGroupOnSuccess?: boolean;
  supported?: false;
  message?: string;
};

export function installedBinary(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const file = join(directory, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* try next */ }
  }
  return undefined;
}

export function planHostAction(host: string, env: NodeJS.ProcessEnv, find: (name: string) => string | undefined, params: ComputerUseParams): HostPlan {
  const no = (message: string): HostPlan => ({ supported: false, message });
  const action = params.action;
  const clipboard = action === "clipboard-read" || action === "clipboard-write";
  const writing = action === "clipboard-write";
  const text = params.clipboardText ?? params.text ?? "";
  const read = (file: string, args: string[]): HostPlan => ({ file, args });
  const write = (file: string, args: string[]): HostPlan => ({ file, args, input: text, capture: false, retainGroupOnSuccess: true });
  const launch = (file: string, args: string[]): HostPlan => ({ file, args, capture: false, retainGroupOnSuccess: true });
  if (host !== "darwin" && host !== "linux") return no("Desktop clipboard and launch integrations are unsupported on this platform; Windows is not implemented.");
  if (clipboard) {
    if (host === "darwin") return writing ? write("/usr/bin/pbcopy", []) : read("/usr/bin/pbpaste", []);
    const session = env.XDG_SESSION_TYPE?.toLowerCase();
    const wayland = session === "wayland" || (session !== "x11" && Boolean(env.WAYLAND_DISPLAY));
    if (!wayland && session !== "x11" && !env.DISPLAY) return no("Clipboard requires an active X11 or Wayland session.");
    if (wayland) {
      const file = find(writing ? "wl-copy" : "wl-paste");
      return file ? writing ? write(file, ["--type", "text/plain;charset=utf-8"]) : read(file, ["--no-newline", "--type", "text"]) : no("Wayland clipboard requires installed wl-copy/wl-paste and compositor clipboard access. XWayland clipboard is not substituted.");
    }
    const xclip = find("xclip");
    if (xclip) return writing ? write(xclip, ["-selection", "clipboard", "-in"]) : read(xclip, ["-selection", "clipboard", "-out"]);
    const xsel = find("xsel");
    if (xsel) return writing ? write(xsel, ["--clipboard", "--input"]) : read(xsel, ["--clipboard", "--output"]);
    return no("X11 clipboard requires installed xclip or xsel and display access.");
  }
  if (host === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !["x11", "wayland"].includes(env.XDG_SESSION_TYPE ?? "")) return no("Launch requires an active graphical session.");
  if (action === "browser-open") {
    let url: URL;
    try { url = new URL(params.url ?? params.path ?? ""); } catch { return no("browser-open requires an absolute HTTP(S) URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return no("browser-open requires an HTTP(S) URL without embedded credentials.");
    const file = host === "darwin" ? "/usr/bin/open" : find("xdg-open");
    return file ? launch(file, [params.url ?? params.path!]) : no("Linux browser-open requires installed xdg-open and a configured browser handler.");
  }
  if (action === "app-launch") {
    const app = params.app ?? "";
    if (host === "darwin") return app && !app.startsWith("-") ? launch("/usr/bin/open", ["-a", app]) : no("app-launch requires a valid application name.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(app)) return no("Linux app-launch requires an installed desktop entry id such as org.example.App.desktop.");
    const file = find("gtk-launch");
    return file ? launch(file, [app]) : no("Linux app-launch requires installed gtk-launch and an installed desktop entry id.");
  }
  return no("Unknown host integration action.");
}

/** Fixed macOS plans identify providers but do not observe executable availability. */
export function discoverHostIntegrations(host: string, env: NodeJS.ProcessEnv, find: (name: string) => string | undefined, observedAtMs: number): HostEvidence["integrations"] {
  const evidence: HostEvidence["integrations"] = {};
  for (const action of ["clipboard-read", "clipboard-write", "browser-open", "app-launch"] as const) {
    const plan = planHostAction(host, env, find, { action, url: "https://example.invalid", app: "org.example.App.desktop" });
    evidence[action] = { state: plan.supported === false ? "unsupported" : "unverified", reasonCodes: [plan.supported === false ? "HOST_PREREQUISITE_UNAVAILABLE" : "HOST_ACCESS_UNVERIFIED"], ...(plan.file ? { provider: { name: plan.file.split(/[\\/]/).at(-1)!, version: null } } : {}), binary: host === "linux" && plan.file ? { status: "passed", observedAtMs } : { status: "unknown" } };
  }
  return evidence;
}
