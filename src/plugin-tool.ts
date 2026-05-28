import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  COMPUTER_USE_AGENT,
  COMPUTER_USE_HEALTH_CHECK,
} from "./computer-use-agent.js";
import {
  buildComputerUseAuditEvent,
  appendComputerUseAuditEvent,
  resolveComputerUseAuditLogPath,
  type ComputerUseAuditEvent,
} from "./computer-use-audit.js";
import {
  classifyComputerUseRequest,
  normalizeAdapterResult,
  normalizeComputerUseAction,
  redactComputerUseValue,
  type ComputerUseParams,
  type ComputerUsePolicyContext,
} from "./computer-use-policy.js";

const execFileAsync = promisify(execFile);

const MAX_TEXT_BYTES = 100_000;
const MAX_ARG_BYTES = 2_048;
const MAX_STDIO_BYTES = 64_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 45_000;
const DEFAULT_ADAPTER_BIN = "coven-desktop-use";

type ToolResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown> & {
    status: string;
    success?: boolean;
    risk?: string;
    reason?: string;
  };
};

type AdapterRunner = (args: string[], params: ComputerUseParams) => Promise<unknown>;
type AuditWriter = (event: ComputerUseAuditEvent) => Promise<unknown>;

export type CreateComputerUseToolOptions = {
  ctx?: ComputerUsePolicyContext;
  runAdapter?: AdapterRunner;
  appendAuditEvent?: AuditWriter;
};

const ComputerUseToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "health",
        "stop",
        "doctor",
        "inspect",
        "screenshot",
        "click",
        "type-text",
        "keypress",
        "scroll",
        "focus",
        "shell",
        "file-list",
        "file-read",
        "file-write",
        "clipboard-read",
        "clipboard-write",
        "browser-open",
        "app-launch",
        "permissions",
        "see",
        "capture",
        "type",
        "press",
      ],
      description: "Computer-use action to perform.",
    },
    app: { type: "string", description: "Target app name, bundle id, or PID:123." },
    windowTitle: { type: "string", description: "Partial target window title." },
    windowId: { type: "number", description: "Platform window id." },
    screenIndex: { type: "number", minimum: 0 },
    mode: { type: "string", enum: ["screen", "window", "frontmost", "auto"] },
    path: { type: "string", description: "Target file path or output image path." },
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
    on: { type: "string", description: "Element id from inspect, e.g. B1." },
    query: { type: "string", description: "Element text/query for click fallback." },
    coords: { type: "string", description: "Coordinate fallback in x,y form." },
    double: { type: "boolean" },
    right: { type: "boolean" },
    text: { type: "string", description: "Text for type-text or clipboard-write." },
    clear: { type: "boolean" },
    pressReturn: { type: "boolean" },
    keys: { type: "array", items: { type: "string" }, description: "Keys for keypress." },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "number", minimum: 1, maximum: 50 },
    command: { type: "string", description: "Executable for shell action. No shell interpolation." },
    args: { type: "array", items: { type: "string" }, description: "Shell argv." },
    cwd: { type: "string", description: "Shell cwd. Defaults to the agent workspace." },
    content: { type: "string", description: "Content for file-write." },
    url: { type: "string", description: "URL for browser-open." },
    clipboardText: { type: "string", description: "Text for clipboard-write." },
    includeText: { type: "boolean", description: "Return approved clipboard/file text when needed." },
    overwrite: { type: "boolean", description: "Allow file-write to replace an existing file." },
    reason: { type: "string", description: "Operator-facing reason for the action." },
    confirm: {
      type: "boolean",
      description:
        "Set by OpenClaw approval hooks after explicit user approval for gated actions.",
    },
    timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
  },
} as const;

const DESKTOP_ADAPTER_ACTIONS = new Set([
  "doctor",
  "inspect",
  "screenshot",
  "click",
  "type-text",
  "keypress",
  "scroll",
  "focus",
]);

const TRANSIENT_RETRY_ACTIONS = new Set(["doctor", "inspect", "screenshot"]);

export function createComputerUseTool(options: CreateComputerUseToolOptions = {}) {
  const ctx = options.ctx ?? {};
  const runAdapter = options.runAdapter ?? runAdapterBinary;
  const appendAuditEvent =
    options.appendAuditEvent ??
    ((event: ComputerUseAuditEvent) => appendComputerUseAuditEvent(event, ctx));

  return {
    name: "computer_use",
    label: "Computer Use",
    description:
      "OpenCoven computer-use agent tool for health checks, observation, approved desktop input, scoped shell/file actions, browser/app launches, and clipboard workflows.",
    parameters: ComputerUseToolSchema,
    async execute(toolCallId: string, rawParams: unknown): Promise<ToolResult> {
      const params = normalizeParams(rawParams);
      const decision = classifyComputerUseRequest(params, ctx);
      let details: ToolResult["details"];

      if (decision.status === "blocked" || decision.status === "needsApproval") {
        details = {
          status: decision.status,
          success: false,
          action: decision.normalizedAction,
          target: decision.target,
          risk: decision.risk,
          reason: decision.reason,
          requiresApproval: decision.requiresApproval,
          approvalPrompt: decision.approvalPrompt,
          params: redactComputerUseValue(params),
        };
      } else {
        details = await executeAllowedAction(params, ctx, runAdapter);
      }

      await appendAuditEvent(
        buildComputerUseAuditEvent({
          toolCallId,
          request: params,
          decision,
          result: details,
          ctx,
        }),
      ).catch(() => undefined);

      return jsonResult(details);
    },
  };
}

export function createDesktopUseTool(options: CreateComputerUseToolOptions = {}) {
  const tool = createComputerUseTool(options);
  return {
    ...tool,
    name: "desktop_use",
    label: "Desktop Use",
    description:
      "Legacy alias for the OpenCoven computer_use tool. Prefer computer_use for new OpenClaw agent policy.",
  };
}

async function executeAllowedAction(
  params: ComputerUseParams,
  ctx: ComputerUsePolicyContext,
  runAdapter: AdapterRunner,
): Promise<ToolResult["details"]> {
  const action = normalizeComputerUseAction(params.action);
  const evidence = {
    action,
    agentId: ctx.agentId ?? COMPUTER_USE_AGENT.id,
    sessionKey: ctx.sessionKey,
  };

  if (DESKTOP_ADAPTER_ACTIONS.has(action)) {
    const raw = await runAdapterWithTransientObservationRetry(
      buildAdapterArgs(params),
      params,
      runAdapter,
      action,
    );
    const normalized = normalizeAdapterResult(raw, { evidence });
    return {
      ...normalized,
      action,
      permissionFlow: permissionFlowForResult(raw, action),
    };
  }

  switch (action) {
    case "health":
      return runHealth(ctx, runAdapter);
    case "stop":
      return stopComputerUse(ctx);
    case "shell":
      return runShell(params, ctx);
    case "file-list":
      return listFiles(params, ctx);
    case "file-read":
      return readTextFile(params, ctx);
    case "file-write":
      return writeTextFile(params, ctx);
    case "clipboard-read":
      return readClipboard(params, ctx);
    case "clipboard-write":
      return writeClipboard(params, ctx);
    case "browser-open":
      return openBrowser(params, ctx);
    case "app-launch":
      return launchApp(params, ctx);
    default:
      return {
        status: "unsupported",
        success: false,
        action,
        evidence,
        result: { message: `Unsupported action: ${action}` },
      };
  }
}

async function runHealth(ctx: ComputerUsePolicyContext, runAdapter: AdapterRunner): Promise<ToolResult["details"]> {
  const adapterBin = resolveAdapterBin();
  let adapterResult: unknown;
  try {
    adapterResult = await runAdapterWithTransientObservationRetry(
      ["doctor"],
      { action: "doctor" },
      runAdapter,
      "health",
    );
  } catch (error) {
    adapterResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const normalized = normalizeAdapterResult(adapterResult, {
    evidence: { action: "health", adapter: adapterBin },
  });
  return {
    ...normalized,
    action: "health",
    agent: COMPUTER_USE_AGENT,
    healthCheck: COMPUTER_USE_HEALTH_CHECK,
    auditLog: resolveComputerUseAuditLogPath(ctx),
    repairHints: [
      missingAdapterHint(adapterBin),
      "Run computer_use action=doctor after granting Screen Recording and Accessibility.",
      "Restart the OpenClaw Gateway after changing COVEN_DESKTOP_USE_BIN or macOS privacy grants.",
    ],
    permissionFlow: permissionFlowForResult(adapterResult, "doctor"),
  };
}

function stopComputerUse(ctx: ComputerUsePolicyContext): ToolResult["details"] {
  return {
    status: "success",
    success: true,
    action: "stop",
    agentId: ctx.agentId ?? COMPUTER_USE_AGENT.id,
    state: "idle",
    result: {
      message:
        "Computer-use stop acknowledged. This tool does not keep a background runner; active host calls are bounded by timeout and gateway cancellation.",
    },
  };
}

async function runAdapterWithTransientObservationRetry(
  args: string[],
  params: ComputerUseParams,
  runAdapter: AdapterRunner,
  action: string,
): Promise<unknown> {
  const first = await runAdapter(args, params);
  if (!shouldRetryAdapterResult(first, action)) {
    return first;
  }
  return runAdapter(args, params);
}

function shouldRetryAdapterResult(result: unknown, action: string): boolean {
  const retryableAction = action === "health" || TRANSIENT_RETRY_ACTIONS.has(action);
  if (!retryableAction || !result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (record.ok === true || record.supported === false) {
    return false;
  }
  if (looksLikePermissionFailure(result)) {
    return false;
  }
  const haystack = [
    record.error,
    record.code,
    record.stderr,
    record.message,
  ]
    .filter((value) => value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join("\n");
  return /(^|\b)(etimedout|econnreset|eagain|timeout|timed out|temporar|stale|busy)(\b|$)/i.test(
    haystack,
  );
}

async function runShell(params: ComputerUseParams, ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  const command = requireString(params.command, "shell requires command.");
  const args = params.args ?? [];
  const cwd = resolveCwd(params.cwd, ctx.workspaceDir);
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer: MAX_STDIO_BYTES,
    });
    return {
      status: "success",
      success: true,
      action: "shell",
      cwd,
      command: redactComputerUseValue({ command, args }),
      stdout: truncateText(String(stdout ?? "")),
      stderr: truncateText(String(stderr ?? "")),
      exitCode: 0,
    };
  } catch (error) {
    const err = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    return {
      status: "error",
      success: false,
      action: "shell",
      cwd,
      command: redactComputerUseValue({ command, args }),
      error: err.message,
      code: err.code,
      stdout: err.stdout ? truncateText(String(err.stdout)) : undefined,
      stderr: err.stderr ? truncateText(String(err.stderr)) : undefined,
    };
  }
}

async function listFiles(params: ComputerUseParams, ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  const target = resolveTargetPath(params.path ?? ctx.workspaceDir ?? ".", ctx.workspaceDir);
  const entries = await readdir(target, { withFileTypes: true });
  return {
    status: "success",
    success: true,
    action: "file-list",
    path: target,
    entries: entries.slice(0, 500).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })),
    truncated: entries.length > 500,
  };
}

async function readTextFile(params: ComputerUseParams, ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  const target = resolveTargetPath(requireString(params.path, "file-read requires path."), ctx.workspaceDir);
  const file = await readFile(target);
  const text = file.toString("utf8");
  return {
    status: "success",
    success: true,
    action: "file-read",
    path: target,
    bytes: file.byteLength,
    sha256: createHash("sha256").update(file).digest("hex"),
    text: params.includeText === true ? truncateText(text) : undefined,
    preview: truncateText(text, 1_000),
  };
}

async function writeTextFile(params: ComputerUseParams, ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  const target = resolveTargetPath(requireString(params.path, "file-write requires path."), ctx.workspaceDir);
  const content = requireString(params.content, "file-write requires content.");
  assertMaxBytes(content, "content", MAX_TEXT_BYTES);
  const existed = existsSync(target);
  if (existed && params.overwrite !== true) {
    return {
      status: "needsApproval",
      success: false,
      action: "file-write",
      path: target,
      reason: "file exists; repeat with overwrite:true after reviewing the existing file.",
    };
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: existed ? "w" : "wx", mode: 0o600 });
  return {
    status: "success",
    success: true,
    action: "file-write",
    path: target,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"),
    overwrote: existed,
  };
}

async function readClipboard(params: ComputerUseParams, _ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  if (platform() !== "darwin") {
    return unsupported("clipboard-read", "Clipboard adapter currently supports macOS pbpaste only.");
  }
  const { stdout } = await execFileAsync("/usr/bin/pbpaste", [], {
    timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_STDIO_BYTES,
  });
  const text = String(stdout ?? "");
  return {
    status: "success",
    success: true,
    action: "clipboard-read",
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
    text: params.includeText === true ? truncateText(text) : undefined,
    preview: truncateText(text, 200),
  };
}

async function writeClipboard(params: ComputerUseParams, _ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  if (platform() !== "darwin") {
    return unsupported("clipboard-write", "Clipboard adapter currently supports macOS pbcopy only.");
  }
  const text = params.clipboardText ?? params.text;
  if (typeof text !== "string") {
    throw new ToolInputError("clipboard-write requires clipboardText or text.");
  }
  await writeProcessStdin("/usr/bin/pbcopy", [], text, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return {
    status: "success",
    success: true,
    action: "clipboard-write",
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

async function openBrowser(params: ComputerUseParams, _ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  const url = requireString(params.url ?? params.path, "browser-open requires url.");
  if (platform() !== "darwin") {
    return unsupported("browser-open", "Browser launch currently supports macOS open only.");
  }
  await execFileAsync("/usr/bin/open", [url], {
    timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    status: "success",
    success: true,
    action: "browser-open",
    url,
  };
}

async function launchApp(params: ComputerUseParams, _ctx: ComputerUsePolicyContext): Promise<ToolResult["details"]> {
  const app = requireString(params.app, "app-launch requires app.");
  if (platform() !== "darwin") {
    return unsupported("app-launch", "App launch currently supports macOS open -a only.");
  }
  await execFileAsync("/usr/bin/open", ["-a", app], {
    timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    status: "success",
    success: true,
    action: "app-launch",
    app,
  };
}

function unsupported(action: string, message: string): ToolResult["details"] {
  return {
    status: "unsupported",
    success: false,
    action,
    result: { ok: false, supported: false, message },
  };
}

function writeProcessStdin(
  file: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${file} exited ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`));
      }
    });
    child.stdin.end(input);
  });
}

function normalizeParams(params: unknown): ComputerUseParams {
  if (!params || typeof params !== "object") {
    throw new ToolInputError("Parameters are required.");
  }
  const record = params as Partial<ComputerUseParams>;
  if (!record.action) {
    throw new ToolInputError("action is required.");
  }
  for (const [label, value] of Object.entries(record)) {
    if (typeof value === "string") {
      assertMaxBytes(
        value,
        label,
        label === "text" || label === "clipboardText" || label === "content"
          ? MAX_TEXT_BYTES
          : MAX_ARG_BYTES,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") assertMaxBytes(item, label, MAX_ARG_BYTES);
      }
    }
  }
  if (record.coords && !/^\d{1,5},\d{1,5}$/.test(record.coords.trim())) {
    throw new ToolInputError("coords must be in x,y form, for example 120,240.");
  }
  return record as ComputerUseParams;
}

async function runAdapterBinary(args: string[], params: ComputerUseParams): Promise<unknown> {
  const timeout =
    params.timeoutMs ??
    (normalizeComputerUseAction(params.action) === "inspect" ||
    normalizeComputerUseAction(params.action) === "screenshot"
      ? CAPTURE_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS);
  const adapterBin = resolveAdapterBin();
  try {
    const { stdout, stderr } = await execFileAsync(adapterBin, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      adapter: adapterBin,
      args: redactArgsForDetails(args),
      result: parseJsonOrText(stdout),
      stderr: stderr ? String(stderr) : undefined,
    };
  } catch (err) {
    const error = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    return {
      ok: false,
      adapter: adapterBin,
      args: redactArgsForDetails(args),
      error: error.message,
      code: error.code,
      stdout: error.stdout ? parseJsonOrText(error.stdout) : undefined,
      stderr: error.stderr ? String(error.stderr).slice(0, 4000) : undefined,
      hint: missingAdapterHint(adapterBin),
      adapterSetup: adapterSetupGuide(adapterBin),
    };
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

function buildAdapterArgs(params: ComputerUseParams): string[] {
  const action = normalizeComputerUseAction(params.action);
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
      throw new ToolInputError(`Unsupported adapter action: ${String(params.action)}`);
  }
}

function buildInspectArgs(params: ComputerUseParams): string[] {
  const args = ["inspect"];
  addCommonTargetArgs(args, params);
  if (params.mode) args.push("--mode", params.mode);
  if (typeof params.screenIndex === "number") args.push("--screen-index", String(params.screenIndex));
  if (params.annotate === false) args.push("--no-annotate");
  if (params.path) args.push("--path", params.path);
  if (params.analyze) args.push("--analyze", params.analyze);
  return args;
}

function buildScreenshotArgs(params: ComputerUseParams): string[] {
  const args = ["screenshot"];
  if (params.mode) args.push("--mode", params.mode);
  if (params.format) args.push("--format", params.format);
  addCommonTargetArgs(args, params);
  if (typeof params.screenIndex === "number") args.push("--screen-index", String(params.screenIndex));
  if (params.retina) args.push("--retina");
  if (params.path) args.push("--path", params.path);
  if (params.analyze) args.push("--analyze", params.analyze);
  return args;
}

function buildClickArgs(params: ComputerUseParams): string[] {
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

function buildTypeTextArgs(params: ComputerUseParams): string[] {
  if (!params.text) throw new ToolInputError("type-text requires text.");
  const args = ["type-text", "--confirm", "--text", params.text];
  if (params.clear) args.push("--clear");
  if (params.pressReturn) args.push("--return");
  addCommonTargetArgs(args, params);
  return args;
}

function buildKeypressArgs(params: ComputerUseParams): string[] {
  if (!params.keys?.length) throw new ToolInputError("keypress requires keys.");
  const args = ["keypress", "--confirm", "--keys", params.keys.join(",")];
  addCommonTargetArgs(args, params);
  return args;
}

function buildScrollArgs(params: ComputerUseParams): string[] {
  if (!params.direction) throw new ToolInputError("scroll requires direction.");
  const args = ["scroll", "--confirm", "--direction", params.direction, "--amount", String(params.amount ?? 3)];
  if (params.on) args.push("--on", params.on);
  addCommonTargetArgs(args, params);
  return args;
}

function buildFocusArgs(params: ComputerUseParams): string[] {
  if (!params.windowId && !params.windowTitle && !params.app) {
    throw new ToolInputError("focus requires app, windowTitle, or windowId.");
  }
  const args = ["focus", "--confirm"];
  addCommonTargetArgs(args, params);
  return args;
}

function addCommonTargetArgs(args: string[], params: ComputerUseParams): void {
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
  const platform = readStringField(result, "platform");
  if (platform === "linux") {
    return linuxPermissionFlow(result, action);
  }
  if (action !== "doctor" && !looksLikePermissionFailure(result)) {
    return undefined;
  }
  return {
    summary: "macOS privacy permission is required before desktop inspection or interaction can work.",
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
      "Quit/restart the granted app or restart the OpenClaw Gateway, then rerun computer_use action=doctor.",
    verification: { tool: "computer_use", args: { action: "doctor" } },
  };
}

function inferLinuxSession(result: unknown): string | undefined {
  const session = readStringField(result, "session");
  if (session) return session;
  const backend = readStringField(result, "backend") ?? "";
  if (backend.startsWith("wayland")) return "wayland";
  if (backend.startsWith("x11")) return "x11";
  return undefined;
}

function linuxPermissionFlow(result: unknown, action: string): unknown | undefined {
  const setupGuide = readObjectField(result, "setupGuide");
  const tools = readObjectField(result, "tools");
  const session = inferLinuxSession(result);
  const errorText = readStringField(result, "error") ?? "";
  const missingTool = errorText.startsWith("Missing required tool");

  if (action !== "doctor" && !missingTool && !setupGuide) {
    return undefined;
  }

  return {
    platform: "linux",
    session: session ?? null,
    summary:
      readStringField(setupGuide, "summary") ??
      "Linux desktop-use requires per-session helper tools (scrot/xdotool on X11, grim/wtype/ydotool on Wayland).",
    installCommand:
      readStringField(setupGuide, "installCommand") ??
      (session === "wayland"
        ? "sudo apt install grim wtype ydotool"
        : "sudo apt install scrot xdotool wmctrl"),
    missingTools: readArrayField(setupGuide, "missingTools") ?? [],
    tools: tools ?? null,
    sessionNotes: collectSessionNotes(setupGuide),
    afterInstall:
      "After installing the listed packages, rerun desktop_use action=doctor. Wayland users may also need to start the ydotoold service and add their user to the 'input' group.",
    verification: { tool: "desktop_use", args: { action: "doctor" } },
  };
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = (value as Record<string, unknown>)[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function readArrayField(value: unknown, key: string): unknown[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = (value as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : undefined;
}

function collectSessionNotes(
  setupGuide: Record<string, unknown> | undefined,
): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const key of ["ydotoolNote", "focusNote", "scrollNote", "elementIdNote"]) {
    const v = readStringField(setupGuide, key);
    if (v) notes[key] = v;
  }
  return notes;
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

function jsonResult(details: ToolResult["details"]): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function resolveCwd(cwd: string | undefined, workspaceDir: string | undefined): string {
  const resolved = resolve(cwd ?? workspaceDir ?? process.cwd());
  if (workspaceDir && isOutside(resolve(workspaceDir), resolved)) {
    throw new ToolInputError("cwd is outside the configured computer-use workspace.");
  }
  return resolved;
}

function resolveTargetPath(target: string, workspaceDir: string | undefined): string {
  const resolved = isAbsolute(target) ? resolve(target) : resolve(workspaceDir ?? process.cwd(), target);
  if (workspaceDir) {
    const workspace = resolve(workspaceDir);
    const rel = relative(workspace, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      // The policy layer can approve exact out-of-workspace paths. Keep the execution path exact.
      return resolved;
    }
  }
  return resolved;
}

function isOutside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.startsWith("..") || isAbsolute(rel);
}

function truncateText(value: string, maxBytes = MAX_STDIO_BYTES): string {
  return Buffer.byteLength(value, "utf8") > maxBytes ? `${value.slice(0, maxBytes)}...<truncated>` : value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(message);
  }
  return value;
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
