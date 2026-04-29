import { execFile } from "node:child_process";
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
        Type.Literal("permissions"),
        Type.Literal("see"),
        Type.Literal("capture"),
        Type.Literal("click"),
        Type.Literal("type"),
        Type.Literal("press"),
        Type.Literal("scroll"),
        Type.Literal("focus"),
      ],
      { description: "Desktop action to perform." },
    ),
    app: Type.Optional(Type.String({ description: "Target app name, bundle id, or PID:123." })),
    windowTitle: Type.Optional(Type.String({ description: "Partial target window title." })),
    windowId: Type.Optional(Type.Number({ description: "Platform window id." })),
    screenIndex: Type.Optional(Type.Number({ minimum: 0 })),
    mode: Type.Optional(CaptureMode),
    path: Type.Optional(Type.String({ description: "Output image path for capture/see." })),
    format: Type.Optional(ImageFormat),
    annotate: Type.Optional(
      Type.Boolean({ description: "Annotate UI elements for see. Default true." }),
    ),
    retina: Type.Optional(
      Type.Boolean({ description: "Capture at Retina resolution when supported." }),
    ),
    analyze: Type.Optional(Type.String({ description: "Optional backend analysis prompt." })),
    on: Type.Optional(
      Type.String({ description: "Element id from desktop_use action=see, e.g. B1." }),
    ),
    query: Type.Optional(Type.String({ description: "Element text/query for click fallback." })),
    coords: Type.Optional(Type.String({ description: "Coordinate fallback in x,y form." })),
    double: Type.Optional(Type.Boolean()),
    right: Type.Optional(Type.Boolean()),
    text: Type.Optional(Type.String({ description: "Text for type action." })),
    clear: Type.Optional(Type.Boolean()),
    pressReturn: Type.Optional(Type.Boolean()),
    keys: Type.Optional(Type.Array(Type.String(), { description: "Keys for press action." })),
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
          "Required for interactive actions (click/type/press/scroll/focus) after explicit user approval.",
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

const INTERACTIVE_ACTIONS = new Set(["click", "type", "press", "scroll", "focus"]);

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
            "Interactive desktop actions require confirm:true after explicit user approval. Use permissions/see/capture first.",
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
    (params.action === "see" || params.action === "capture"
      ? CAPTURE_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS);
  const adapterBin = process.env.COVEN_DESKTOP_USE_BIN || DEFAULT_ADAPTER_BIN;
  try {
    const { stdout, stderr } = await execFileAsync(adapterBin, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return jsonResult({
      ok: true,
      adapter: adapterBin,
      args: redactArgsForDetails(args),
      result: parseJsonOrText(stdout),
      stderr: stderr ? String(stderr) : undefined,
    });
  } catch (err) {
    const error = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    return jsonResult({
      ok: false,
      adapter: adapterBin,
      args: redactArgsForDetails(args),
      error: error.message,
      code: error.code,
      stdout: error.stdout ? parseJsonOrText(error.stdout) : undefined,
      stderr: error.stderr ? String(error.stderr).slice(0, 4000) : undefined,
      hint: `Install the OpenCoven adapter or set COVEN_DESKTOP_USE_BIN to its path. Expected binary: ${DEFAULT_ADAPTER_BIN}`,
    });
  }
}

function buildAdapterArgs(params: DesktopUseParams): string[] {
  switch (params.action) {
    case "permissions":
      return ["permissions"];
    case "see":
      return buildSeeArgs(params);
    case "capture":
      return buildCaptureArgs(params);
    case "click":
      return buildClickArgs(params);
    case "type":
      return buildTypeArgs(params);
    case "press":
      return buildPressArgs(params);
    case "scroll":
      return buildScrollArgs(params);
    case "focus":
      return buildFocusArgs(params);
    default:
      throw new ToolInputError(`Unsupported action: ${String(params.action)}`);
  }
}

function buildSeeArgs(params: DesktopUseParams): string[] {
  const args = ["see"];
  addCommonTargetArgs(args, params);
  if (params.mode) args.push("--mode", params.mode);
  if (typeof params.screenIndex === "number")
    args.push("--screen-index", String(params.screenIndex));
  if (params.annotate === false) args.push("--no-annotate");
  if (params.path) args.push("--path", params.path);
  if (params.analyze) args.push("--analyze", params.analyze);
  return args;
}

function buildCaptureArgs(params: DesktopUseParams): string[] {
  const args = ["capture"];
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

function buildTypeArgs(params: DesktopUseParams): string[] {
  if (!params.text) throw new ToolInputError("type requires text.");
  const args = ["type", "--confirm", "--text", params.text];
  if (params.clear) args.push("--clear");
  if (params.pressReturn) args.push("--return");
  addCommonTargetArgs(args, params);
  return args;
}

function buildPressArgs(params: DesktopUseParams): string[] {
  if (!params.keys?.length) throw new ToolInputError("press requires keys.");
  const args = ["press", "--confirm", "--keys", params.keys.join(",")];
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
