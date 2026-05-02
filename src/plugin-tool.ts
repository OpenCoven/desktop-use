import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_TEXT_BYTES = 10_000;
const MAX_ARG_BYTES = 2_048;
const DEFAULT_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 45_000;
const DEFAULT_ADAPTER_BIN = "coven-desktop-use";

type DesktopUseAction =
  | "doctor"
  | "inspect"
  | "screenshot"
  | "click"
  | "type-text"
  | "keypress"
  | "scroll"
  | "focus"
  | "permissions"
  | "see"
  | "capture"
  | "type"
  | "press";

type DesktopUseParams = {
  action: DesktopUseAction;
  app?: string;
  windowTitle?: string;
  windowId?: number;
  screenIndex?: number;
  mode?: "screen" | "window" | "frontmost" | "auto";
  path?: string;
  format?: "png" | "jpg";
  annotate?: boolean;
  retina?: boolean;
  analyze?: string;
  on?: string;
  query?: string;
  coords?: string;
  double?: boolean;
  right?: boolean;
  text?: string;
  clear?: boolean;
  pressReturn?: boolean;
  keys?: string[];
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  confirm?: boolean;
  timeoutMs?: number;
};

const DesktopUseToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "doctor",
        "inspect",
        "screenshot",
        "click",
        "type-text",
        "keypress",
        "scroll",
        "focus",
        "permissions",
        "see",
        "capture",
        "type",
        "press",
      ],
      description: "Desktop action to perform.",
    },
    app: { type: "string", description: "Target app name, bundle id, or PID:123." },
    windowTitle: { type: "string", description: "Partial target window title." },
    windowId: { type: "number", description: "Platform window id." },
    screenIndex: { type: "number", minimum: 0 },
    mode: { type: "string", enum: ["screen", "window", "frontmost", "auto"] },
    path: { type: "string", description: "Output image path for screenshot/inspect." },
    format: { type: "string", enum: ["png", "jpg"] },
    annotate: {
      type: "boolean",
      description: "Annotate UI elements for inspect. Default true.",
    },
    retina: {
      type: "boolean",
      description: "Capture at Retina resolution when supported.",
    },
    analyze: { type: "string", description: "Optional backend analysis prompt." },
    on: { type: "string", description: "Element id from desktop_use action=inspect, e.g. B1." },
    query: { type: "string", description: "Element text/query for click fallback." },
    coords: { type: "string", description: "Coordinate fallback in x,y form." },
    double: { type: "boolean" },
    right: { type: "boolean" },
    text: { type: "string", description: "Text for type-text action." },
    clear: { type: "boolean" },
    pressReturn: { type: "boolean" },
    keys: { type: "array", items: { type: "string" }, description: "Keys for keypress action." },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "number", minimum: 1, maximum: 50 },
    confirm: {
      type: "boolean",
      description:
        "Required for interactive actions (click/type-text/keypress/scroll/focus) after explicit user approval.",
    },
    timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
  },
} as const;

type ToolResult = {
  content: [{ type: "text"; text: string }];
  details: unknown;
};

const INTERACTIVE_ACTIONS = new Set(["click", "type-text", "keypress", "scroll", "focus", "type", "press"]);

export function createDesktopUseTool() {
  return {
    name: "desktop_use",
    label: "Desktop Use",
    description:
      "OpenCoven desktop-use tool that delegates to the external coven-desktop-use adapter. OpenClaw owns approval policy; the adapter owns platform backends.",
    parameters: DesktopUseToolSchema,
    async execute(_toolCallId: string, rawParams: unknown): Promise<ToolResult> {
      const params = normalizeParams(rawParams as DesktopUseParams);
      if (INTERACTIVE_ACTIONS.has(params.action) && params.confirm !== true) {
        return jsonResult({
          ok: false,
          requiresConfirmation: true,
          action: params.action,
          message:
            "Interactive desktop actions require confirm:true after explicit user approval. Use doctor/inspect/screenshot first.",
        });
      }
      return runAdapter(buildAdapterArgs(params), params);
    },
  };
}

function normalizeParams(params: DesktopUseParams): DesktopUseParams {
  if (!params || typeof params !== "object") {
    throw new ToolInputError("Parameters are required.");
  }
  if (!params.action) {
    throw new ToolInputError("action is required.");
  }
  for (const [label, value] of Object.entries(params)) {
    if (typeof value === "string") {
      assertMaxBytes(value, label, label === "text" ? MAX_TEXT_BYTES : MAX_ARG_BYTES);
    }
  }
  if (params.coords && !/^\d{1,5},\d{1,5}$/.test(params.coords.trim())) {
    throw new ToolInputError("coords must be in x,y form, for example 120,240.");
  }
  return params;
}

async function runAdapter(args: string[], params: DesktopUseParams): Promise<ToolResult> {
  const timeout =
    params.timeoutMs ??
    (normalizeAction(params.action) === "inspect" || normalizeAction(params.action) === "screenshot"
      ? CAPTURE_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS);
  const adapterBin = resolveAdapterBin();
  try {
    const { stdout, stderr } = await execFileAsync(adapterBin, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = parseJsonOrText(stdout);
    return jsonResult({
      ok: true,
      adapter: adapterBin,
      args: redactArgsForDetails(args),
      result,
      permissionFlow: permissionFlowForResult(result, params.action),
      stderr: stderr ? String(stderr) : undefined,
    });
  } catch (err) {
    const error = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    const stdout = error.stdout ? parseJsonOrText(error.stdout) : undefined;
    return jsonResult({
      ok: false,
      adapter: adapterBin,
      args: redactArgsForDetails(args),
      error: error.message,
      code: error.code,
      stdout,
      stderr: error.stderr ? String(error.stderr).slice(0, 4000) : undefined,
      hint: missingAdapterHint(adapterBin),
      permissionFlow: permissionFlowForResult(stdout, params.action),
      adapterSetup: adapterSetupGuide(adapterBin),
    });
  }
}

function resolveAdapterBin(): string {
  if (process.env.COVEN_DESKTOP_USE_BIN) {
    return process.env.COVEN_DESKTOP_USE_BIN;
  }
  const cargoBin = `${homedir()}/.cargo/bin/${DEFAULT_ADAPTER_BIN}`;
  if (existsSync(cargoBin)) {
    return cargoBin;
  }
  return DEFAULT_ADAPTER_BIN;
}

function buildAdapterArgs(params: DesktopUseParams): string[] {
  const action = normalizeAction(params.action);
  switch (action) {
    case "doctor":
      return ["doctor"];
    case "inspect":
      return buildInspectArgs(params);
    case "screenshot":
      return buildScreenshotArgs(params);
    case "click":
      return buildClickArgs(params);
    case "type-text":
      return buildTypeTextArgs(params);
    case "keypress":
      return buildKeypressArgs(params);
    case "scroll":
      return buildScrollArgs(params);
    case "focus":
      return buildFocusArgs(params);
    default:
      throw new ToolInputError(`Unsupported action: ${String(params.action)}`);
  }
}

function normalizeAction(action: DesktopUseParams["action"]): string {
  switch (action) {
    case "permissions":
      return "doctor";
    case "see":
      return "inspect";
    case "capture":
      return "screenshot";
    case "type":
      return "type-text";
    case "press":
      return "keypress";
    default:
      return action;
  }
}

function buildInspectArgs(params: DesktopUseParams): string[] {
  const args = ["inspect"];
  addCommonTargetArgs(args, params);
  if (params.mode) args.push("--mode", params.mode);
  if (typeof params.screenIndex === "number")
    args.push("--screen-index", String(params.screenIndex));
  if (params.annotate === false) args.push("--no-annotate");
  if (params.path) args.push("--path", params.path);
  if (params.analyze) args.push("--analyze", params.analyze);
  return args;
}

function buildScreenshotArgs(params: DesktopUseParams): string[] {
  const args = ["screenshot"];
  if (params.mode) args.push("--mode", params.mode);
  if (params.format) args.push("--format", params.format);
  addCommonTargetArgs(args, params);
  if (typeof params.screenIndex === "number")
    args.push("--screen-index", String(params.screenIndex));
  if (params.retina) args.push("--retina");
  if (params.path) args.push("--path", params.path);
  if (params.analyze) args.push("--analyze", params.analyze);
  return args;
}

function buildClickArgs(params: DesktopUseParams): string[] {
  if (!params.query && !params.on && !params.coords) {
    throw new ToolInputError("click requires on, query, or coords.");
  }
  const args = ["click", "--confirm"];
  if (params.query) args.push("--query", params.query);
  if (params.on) args.push("--on", params.on);
  if (params.coords) args.push("--coords", params.coords);
  if (params.double) args.push("--double");
  if (params.right) args.push("--right");
  addCommonTargetArgs(args, params);
  return args;
}

function buildTypeTextArgs(params: DesktopUseParams): string[] {
  if (!params.text) throw new ToolInputError("type-text requires text.");
  const args = ["type-text", "--confirm", "--text", params.text];
  if (params.clear) args.push("--clear");
  if (params.pressReturn) args.push("--return");
  addCommonTargetArgs(args, params);
  return args;
}

function buildKeypressArgs(params: DesktopUseParams): string[] {
  if (!params.keys?.length) throw new ToolInputError("keypress requires keys.");
  const args = ["keypress", "--confirm", "--keys", params.keys.join(",")];
  addCommonTargetArgs(args, params);
  return args;
}

function buildScrollArgs(params: DesktopUseParams): string[] {
  if (!params.direction) throw new ToolInputError("scroll requires direction.");
  const args = [
    "scroll",
    "--confirm",
    "--direction",
    params.direction,
    "--amount",
    String(params.amount ?? 3),
  ];
  if (params.on) args.push("--on", params.on);
  addCommonTargetArgs(args, params);
  return args;
}

function buildFocusArgs(params: DesktopUseParams): string[] {
  if (!params.windowId && !params.windowTitle && !params.app) {
    throw new ToolInputError("focus requires app, windowTitle, or windowId.");
  }
  const args = ["focus", "--confirm"];
  addCommonTargetArgs(args, params);
  return args;
}

function addCommonTargetArgs(args: string[], params: DesktopUseParams): void {
  if (params.app) args.push("--app", params.app);
  if (params.windowTitle) args.push("--window-title", params.windowTitle);
  if (typeof params.windowId === "number") args.push("--window-id", String(params.windowId));
}

function parseJsonOrText(stdout: string | Buffer): unknown {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 8000) };
  }
}

function permissionFlowForResult(result: unknown, action: string): unknown | undefined {
  if (action !== "doctor" && !looksLikePermissionFailure(result)) {
    return undefined;
  }
  return {
    summary:
      "macOS privacy permission is required before desktop inspection or interaction can work.",
    requiredPermissions: ["Screen Recording", "Accessibility"],
    systemSettings: [
      {
        label: "Screen Recording",
        path: "System Settings > Privacy & Security > Screen Recording",
        uri: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      },
      {
        label: "Accessibility",
        path: "System Settings > Privacy & Security > Accessibility",
        uri: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      },
    ],
    primaryBinariesToAdd: primaryPermissionBinaries(),
    grantTargets: [
      ...primaryPermissionBinaries(),
      "the terminal app or service that launched OpenClaw",
      "node",
      "openclaw",
    ],
    afterGrant:
      "Quit/restart the granted app or restart the OpenClaw Gateway, then rerun desktop_use action=doctor.",
    verification: { tool: "desktop_use", args: { action: "doctor" } },
  };
}

function primaryPermissionBinaries(): string[] {
  const adapter = resolveAdapterBin();
  const peekaboo = resolvePathBinary("peekaboo") ?? "peekaboo";
  return Array.from(new Set([adapter, peekaboo]));
}

function resolvePathBinary(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function looksLikePermissionFailure(value: unknown): boolean {
  const text = JSON.stringify(value ?? "");
  return (
    text.includes("PERMISSION_ERROR") ||
    text.includes("Screen recording permission") ||
    (text.includes("Screen Recording") && text.includes("isGranted") && text.includes("false")) ||
    (text.includes("Accessibility") && text.includes("isGranted") && text.includes("false"))
  );
}

function missingAdapterHint(adapterBin: string): string {
  if (adapterBin === DEFAULT_ADAPTER_BIN) {
    return `Adapter binary not found on PATH. Install the OpenCoven adapter or set COVEN_DESKTOP_USE_BIN to an absolute path. Expected binary: ${DEFAULT_ADAPTER_BIN}`;
  }
  return `Adapter binary not found or not executable at COVEN_DESKTOP_USE_BIN=${adapterBin}. Set COVEN_DESKTOP_USE_BIN to the coven-desktop-use binary path and restart the OpenClaw Gateway.`;
}

function adapterSetupGuide(adapterBin: string): unknown {
  return {
    expectedBinary: DEFAULT_ADAPTER_BIN,
    configuredBinary: adapterBin,
    envVar: "COVEN_DESKTOP_USE_BIN",
    installCommand: "cargo install --git https://github.com/OpenCoven/desktop-use coven-desktop-use",
    restartAfterChangingEnv: true,
  };
}

function redactArgsForDetails(args: string[]): string[] {
  const redacted = [...args];
  const textIndex = redacted.indexOf("--text");
  if (textIndex >= 0 && redacted[textIndex + 1]) {
    redacted[textIndex + 1] = `<${Buffer.byteLength(redacted[textIndex + 1], "utf8")}-byte text>`;
  }
  return redacted;
}

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function assertMaxBytes(value: string, label: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ToolInputError(`${label} exceeds maximum size (${maxBytes} bytes).`);
  }
}

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
