import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Static, Type } from "typebox";

const execFileAsync = promisify(execFile);

const MAX_TEXT_BYTES = 10_000;
const MAX_ARG_BYTES = 2_048;
const DEFAULT_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 45_000;
const DEFAULT_ADAPTER_BIN = "coven-desktop-use";

const CaptureMode = Type.Union([
  Type.Literal("screen"),
  Type.Literal("window"),
  Type.Literal("frontmost"),
  Type.Literal("auto"),
]);
const ImageFormat = Type.Union([Type.Literal("png"), Type.Literal("jpg")]);

const DesktopUseToolSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("doctor"),
        Type.Literal("inspect"),
        Type.Literal("screenshot"),
        Type.Literal("click"),
        Type.Literal("type-text"),
        Type.Literal("keypress"),
        Type.Literal("scroll"),
        Type.Literal("focus"),
        // Backward-compatible aliases from 0.1.0.
        Type.Literal("permissions"),
        Type.Literal("see"),
        Type.Literal("capture"),
        Type.Literal("type"),
        Type.Literal("press"),
      ],
      { description: "Desktop action to perform." },
    ),
    app: Type.Optional(Type.String({ description: "Target app name, bundle id, or PID:123." })),
    windowTitle: Type.Optional(Type.String({ description: "Partial target window title." })),
    windowId: Type.Optional(Type.Number({ description: "Platform window id." })),
    screenIndex: Type.Optional(Type.Number({ minimum: 0 })),
    mode: Type.Optional(CaptureMode),
    path: Type.Optional(Type.String({ description: "Output image path for screenshot/inspect." })),
    format: Type.Optional(ImageFormat),
    annotate: Type.Optional(
      Type.Boolean({ description: "Annotate UI elements for inspect. Default true." }),
    ),
    retina: Type.Optional(
      Type.Boolean({ description: "Capture at Retina resolution when supported." }),
    ),
    analyze: Type.Optional(Type.String({ description: "Optional backend analysis prompt." })),
    on: Type.Optional(
      Type.String({ description: "Element id from desktop_use action=inspect, e.g. B1." }),
    ),
    query: Type.Optional(Type.String({ description: "Element text/query for click fallback." })),
    coords: Type.Optional(Type.String({ description: "Coordinate fallback in x,y form." })),
    double: Type.Optional(Type.Boolean()),
    right: Type.Optional(Type.Boolean()),
    text: Type.Optional(Type.String({ description: "Text for type-text action." })),
    clear: Type.Optional(Type.Boolean()),
    pressReturn: Type.Optional(Type.Boolean()),
    keys: Type.Optional(Type.Array(Type.String(), { description: "Keys for keypress action." })),
    direction: Type.Optional(
      Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ]),
    ),
    amount: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    confirm: Type.Optional(
      Type.Boolean({
        description:
          "Required for interactive actions (click/type-text/keypress/scroll/focus) after explicit user approval.",
      }),
    ),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120000 })),
  },
  { additionalProperties: false },
);

type DesktopUseParams = Static<typeof DesktopUseToolSchema>;

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
