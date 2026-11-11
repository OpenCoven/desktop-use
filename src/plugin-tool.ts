import { installedBinary, planHostAction } from "./host-actions.js";
import { FileActionError, listDirectory, readRegularFile, writeRegularFile } from "./file-actions.js";
import { runProcess, ProcessFailure } from "./process-runner.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  decodeAdapterAction,
  normalizeAdapterResult,
  normalizeComputerUseAction,
  redactComputerUseValue,
  type ComputerUseParams,
  type ComputerUsePolicyContext,
} from "./computer-use-policy.js";

const activeCalls = new Map<string, Set<AbortController>>();
function scopeKey(ctx: ComputerUsePolicyContext): string {
  return JSON.stringify([ctx.agentId ?? COMPUTER_USE_AGENT.id, ctx.sessionKey ?? "default", ctx.workspaceDir ?? ""]);
}

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

type AdapterRunner = (args: string[], params: ComputerUseParams, signal?: AbortSignal) => Promise<unknown>;
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
    async execute(toolCallId: string, rawParams: unknown, gatewaySignal?: AbortSignal): Promise<ToolResult> {
      let params = normalizeParams(rawParams);
      const controller = new AbortController();
      const abort = () => controller.abort();
      gatewaySignal?.addEventListener("abort", abort, { once: true });
      if (gatewaySignal?.aborted) controller.abort();
      const scope = scopeKey(ctx);
      const calls = activeCalls.get(scope) ?? new Set<AbortController>();
      activeCalls.set(scope, calls);
      if (params.action !== "stop") calls.add(controller);
      let decision = classifyComputerUseRequest(params, ctx);
      let details: ToolResult["details"];
      try {
        const prepared = await prepareComputerUseRequest(params, ctx);
        params = prepared.params;
        decision = prepared.decision;
        if (controller.signal.aborted) throw new ProcessFailure("CANCELLED");
        if (decision.status === "blocked" || decision.status === "needsApproval") {
          details = {
            status: decision.status, success: false, action: decision.normalizedAction,
            target: decision.target, risk: decision.risk, reason: decision.reason,
            requiresApproval: decision.requiresApproval, approvalPrompt: decision.approvalPrompt,
            params: redactComputerUseValue(params),
          };
        } else {
          const boundedAdapter: AdapterRunner = (args, request) => runAdapter(args, request, controller.signal);
          details = await executeAllowedAction(params, ctx, boundedAdapter, controller.signal);
        }
      } catch (error) {
        const code = error instanceof ProcessFailure || error instanceof FileActionError ? error.code : error instanceof ToolInputError ? "INVALID_INPUT" : ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "EEXIST", "EIO", "ENOSPC"].includes((error as NodeJS.ErrnoException)?.code ?? "") ? (error as NodeJS.ErrnoException).code! : "ACTION_FAILED";
        details = { status: code === "CANCELLED" ? "cancelled" : code === "ETIMEDOUT" ? "timeout" : "error", success: false,
          action: params.action, code, error: error instanceof ToolInputError ? error.message : "Action failed; raw diagnostics withheld." };
      } finally {
        calls.delete(controller);
        if (!calls.size) activeCalls.delete(scope);
        gatewaySignal?.removeEventListener("abort", abort);
      }
      try {
        await appendAuditEvent(buildComputerUseAuditEvent({ toolCallId, request: params, decision, result: details, ctx }));
      } catch {
        details.audit = { written: false, code: "AUDIT_WRITE_FAILED" };
      }

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
  signal?: AbortSignal,
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
    const safe = action === "type-text" ? redactTypeDiagnostics(decodeAdapterAction(raw)) : raw;
    const normalized = normalizeAdapterResult(safe, { evidence });
    return {
      ...normalized,
      action,
      permissionFlow: permissionFlowForResult(safe, action),
    };
  }

  switch (action) {
    case "health":
      return runHealth(ctx, runAdapter, params, signal);
    case "stop":
      return stopComputerUse(ctx);
    case "shell":
      return runShell(params, ctx, signal);
    case "file-list":
      return listFiles(params, ctx, signal);
    case "file-read":
      return readTextFile(params, ctx, signal);
    case "file-write":
      return writeTextFile(params, ctx, signal);
    case "clipboard-read":
      return readClipboard(params, ctx, signal);
    case "clipboard-write":
      return writeClipboard(params, ctx, signal);
    case "browser-open":
      return openBrowser(params, ctx, signal);
    case "app-launch":
      return launchApp(params, ctx, signal);
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

async function runHealth(ctx: ComputerUsePolicyContext, runAdapter: AdapterRunner, params: ComputerUseParams, _signal?: AbortSignal): Promise<ToolResult["details"]> {
  const adapterBin = resolveAdapterBin();
  let adapterResult: unknown;
  try {
    adapterResult = await runAdapterWithTransientObservationRetry(
      ["doctor"],
      { action: "doctor", timeoutMs: params.timeoutMs },
      runAdapter,
      "health",
    );
  } catch (error) {
    adapterResult = { ok: false, ...safeExecutionError(error) };
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

function safeExecutionError(error: unknown): { code: string; error: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return { code: error instanceof ToolInputError ? "INVALID_INPUT"
    : typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "EEXIST", "EIO", "ENOSPC", "ETIMEDOUT", "CANCELLED"].includes(code) ? code : "ACTION_FAILED",
    error: error instanceof ToolInputError ? error.message : "Computer-use action failed; raw diagnostics withheld." };
}

function stopComputerUse(ctx: ComputerUsePolicyContext): ToolResult["details"] {
  const calls = activeCalls.get(scopeKey(ctx));
  const count = calls?.size ?? 0;
  for (const controller of calls ?? []) controller.abort();
  return { status: "success", success: true, action: "stop", cancellationRequested: count,
    state: count ? "cancelling" : "idle", result: { message: "Cancellation requested for active calls in this agent/session/workspace. Owned helpers terminate within the 250 ms cleanup grace. Completed side effects are not undone; injected runners must honor AbortSignal." } };
}

async function runAdapterWithTransientObservationRetry(
  args: string[],
  params: ComputerUseParams,
  runAdapter: AdapterRunner,
  action: string,
): Promise<unknown> {
  const budget = params.timeoutMs ?? (action === "inspect" || action === "screenshot" ? CAPTURE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const end = Date.now() + budget;
  const first = await runAdapter(args, { ...params, timeoutMs: budget });
  const remaining = end - Date.now();
  if (!shouldRetryAdapterResult(first, action) || remaining < 1) return first;
  return runAdapter(args, { ...params, timeoutMs: remaining });
}

function shouldRetryAdapterResult(result: unknown, action: string): boolean {
  const retryableAction = action === "health" || TRANSIENT_RETRY_ACTIONS.has(action);
  if (!retryableAction || !result || typeof result !== "object") {
    return false;
  }
  const record = decodeAdapterAction(result);
  if (record.ok === true || record.supported === false || record.code === "CANCELLED" || record.code === "ETIMEDOUT") {
    return false;
  }
  if (looksLikePermissionFailure(result)) {
    return false;
  }
  const haystack = [
    record.error && typeof record.error === "object" ? JSON.stringify(record.error) : record.error,
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

async function runShell(params: ComputerUseParams, ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  const command = requireString(params.command, "shell requires command.");
  const args = params.args ?? [];
  const canonicalWorkspace = ctx.workspaceDir ? await realpath(ctx.workspaceDir) : undefined;
  const cwd = resolveCwd(await canonicalTarget(params.cwd ?? ctx.workspaceDir ?? process.cwd(), ctx.workspaceDir), canonicalWorkspace);
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { stdout, stderr } = await runProcess(command, args, {
    cwd,
    timeoutMs: timeout,
    signal,
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
}

async function listFiles(params: ComputerUseParams, ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  const target = resolveTargetPath(params.path ?? ctx.workspaceDir ?? ".", ctx.workspaceDir);
  const result = await listDirectory(target, signal, Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  return { status: "success", success: true, action: "file-list", path: target, ...result };
}

async function readTextFile(params: ComputerUseParams, ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  const target = resolveTargetPath(requireString(params.path, "file-read requires path."), ctx.workspaceDir);
  const file = await readRegularFile(target, signal, Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  return { status: "success", success: true, action: "file-read", path: target, bytes: file.byteLength,
    sha256: createHash("sha256").update(file).digest("hex"), text: params.includeText === true ? truncateText(file.toString("utf8")) : undefined };
}

async function writeTextFile(params: ComputerUseParams, ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  const target = resolveTargetPath(requireString(params.path, "file-write requires path."), ctx.workspaceDir);
  const content = requireString(params.content, "file-write requires content.");
  assertMaxBytes(content, "content", MAX_TEXT_BYTES);
  const existed = existsSync(target);
  if (existed && params.overwrite !== true) return { status: "needsApproval", success: false, action: "file-write", path: target,
    reason: "file exists; repeat with overwrite:true after reviewing the existing file." };
  await writeRegularFile(target, content, params.overwrite === true, signal, Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  return { status: "success", success: true, action: "file-write", path: target, bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"), overwrote: existed };
}

async function runHostAction(params: ComputerUseParams, signal?: AbortSignal): Promise<ToolResult["details"]> {
  const plan = planHostAction(platform(), process.env, installedBinary, params);
  if (!plan.file || !plan.args) return unsupported(params.action, plan.message ?? "Host integration unavailable.");
  const { stdout } = await runProcess(plan.file, plan.args, { ...plan, timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal });
  if (params.action === "clipboard-read" || params.action === "clipboard-write") {
    const text = params.action === "clipboard-read" ? stdout : params.clipboardText ?? params.text ?? "";
    return { status: "success", success: true, action: params.action,
      bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text).digest("hex"),
      ...(params.action === "clipboard-read" && params.includeText === true ? { text: truncateText(text) } : {}) };
  }
  return { status: "success", success: true, action: params.action, launched: true,
    result: { message: "Launch helper accepted the request. A rendered page or application window has not been observed." } };
}

async function readClipboard(params: ComputerUseParams, _ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  return runHostAction(params, signal);
}
async function writeClipboard(params: ComputerUseParams, _ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  if (typeof (params.clipboardText ?? params.text) !== "string") throw new ToolInputError("clipboard-write requires clipboardText or text.");
  return runHostAction(params, signal);
}
async function openBrowser(params: ComputerUseParams, _ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  requireString(params.url ?? params.path, "browser-open requires url.");
  return runHostAction(params, signal);
}
async function launchApp(params: ComputerUseParams, _ctx: ComputerUsePolicyContext, signal?: AbortSignal): Promise<ToolResult["details"]> {
  requireString(params.app, "app-launch requires app.");
  return runHostAction(params, signal);
}

function unsupported(action: string, message: string): ToolResult["details"] {
  return {
    status: "unsupported",
    success: false,
    action,
    result: { ok: false, supported: false, message },
  };
}


export function normalizeParams(params: unknown): ComputerUseParams {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ToolInputError("Parameters must be an object.");
  }
  const record = Object.assign(Object.create(null), Object.fromEntries(Object.entries(params))) as Record<string, unknown>;
  if (typeof record.action !== "string" || !record.action) {
    throw new ToolInputError("action is required and must be a string.");
  }
  const properties: Record<string, {
    type: string;
    enum?: readonly string[];
    minimum?: number;
    maximum?: number;
  }> = ComputerUseToolSchema.properties;
  for (const [label, value] of Object.entries(record)) {
    if (!Object.hasOwn(properties, label)) throw new ToolInputError("Unknown computer-use parameter.");
    const schema = properties[label];
    if (schema.type === "array") {
      if (!Array.isArray(value) || Array.from(value).some((item) => typeof item !== "string")) {
        throw new ToolInputError(`${label} must be an array of strings.`);
      }
      if (value.length > 256) throw new ToolInputError(`${label} exceeds 256 items.`);
      for (const item of value) {
        if (item.includes("\0")) throw new ToolInputError(`${label} must not contain NUL bytes.`);
        assertMaxBytes(item, label, MAX_ARG_BYTES);
      }
    } else if (typeof value !== schema.type) {
      throw new ToolInputError(`${label} has an invalid type.`);
    }
    if (schema.enum && !schema.enum.includes(value as string)) {
      throw new ToolInputError(`${label} has an unsupported value.`);
    }
    if (typeof value === "number" && (
      !Number.isSafeInteger(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )) {
      throw new ToolInputError(`${label} must be an integer within the allowed range.`);
    }
    if (typeof value === "string") {
      if (value.includes("\0")) throw new ToolInputError(`${label} must not contain NUL bytes.`);
      assertMaxBytes(value, label,
        ["text", "clipboardText", "content"].includes(label) ? MAX_TEXT_BYTES : MAX_ARG_BYTES);
    }
  }
  if (Array.isArray(record.keys)) {
    assertMaxBytes(record.keys.join(","), "keys", MAX_ARG_BYTES);
  }
  if (record.coords && !/^\d{1,5},\d{1,5}$/.test((record.coords as string).trim())) {
    throw new ToolInputError("coords must be in x,y form, for example 120,240.");
  }
  const normalized = record as ComputerUseParams;
  const action = normalizeComputerUseAction(normalized.action);
  if (DESKTOP_ADAPTER_ACTIONS.has(action)) buildAdapterArgs(normalized);
  if (action === "keypress" && normalized.keys?.some(key => !key.trim() || key.includes(","))) throw new ToolInputError("keys must contain nonempty individual key/chord names.");
  if (action === "shell") requireString(normalized.command, "shell requires command.");
  if (["file-read", "file-write"].includes(action)) requireString(normalized.path, "File action requires path.");
  if (action === "file-write") requireString(normalized.content, "file-write requires content.");
  if (action === "clipboard-write" && typeof (normalized.clipboardText ?? normalized.text) !== "string") throw new ToolInputError("clipboard-write requires clipboardText or text.");
  if (action === "browser-open") requireString(normalized.url ?? normalized.path, "browser-open requires url.");
  if (action === "app-launch") requireString(normalized.app, "app-launch requires app.");
  return record as ComputerUseParams;
}

async function runAdapterBinary(args: string[], params: ComputerUseParams, signal?: AbortSignal): Promise<unknown> {
  const timeout = params.timeoutMs ?? (params.action === "inspect" || params.action === "screenshot" ? CAPTURE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const adapterBin = resolveAdapterBin();
  try {
    const { stdout } = await runProcess(adapterBin, [...args, "--timeout-ms", String(Math.max(1000, Math.floor(timeout - 100)))], {
      timeoutMs: timeout, signal, maxBuffer: 10 * 1024 * 1024, reportProgress: true,
    });
    let result: unknown;
    try { result = JSON.parse(stdout); } catch { return { ok: false, code: "MALFORMED_OUTPUT", error: "Adapter returned malformed JSON; output withheld." }; }
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as any).ok !== "boolean") {
      return { ok: false, code: "MALFORMED_OUTPUT", error: "Adapter returned an invalid envelope; output withheld." };
    }
    return normalizeComputerUseAction(params.action) === "type-text" ? redactTypeDiagnostics(result) : result;
  } catch (error) {
    const code = error instanceof ProcessFailure || error instanceof FileActionError ? error.code : "BACKEND_ERROR";
    return { ok: false, code, error: "Adapter execution failed; raw diagnostics withheld.",
      ...(["ETIMEDOUT", "CANCELLED"].includes(code) ? error instanceof ProcessFailure && error.progress ? error.progress : { progressUnknown: true } : {}),
      ...(code === "ENOENT" ? { hint: missingAdapterHint(adapterBin), adapterSetup: adapterSetupGuide(adapterBin) } : {}) };
  }
}

// Input actions need outcomes, not arbitrary backend diagnostics that may echo their text.
function redactTypeDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "MALFORMED_OUTPUT" };
  const record = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of ["ok", "supported", "requiresConfirmation", "timedOut", "cancelled", "partial", "progressUnknown"]) {
    if (typeof record[key] === "boolean") fields[key] = record[key];
  }
  for (const key of ["exitCode", "completedSteps", "totalSteps", "failedStep"]) {
    if (Number.isSafeInteger(record[key])) fields[key] = record[key];
  }
  if (["peekaboo", "xdotool", "ydotool", "wtype", "linux"].includes(String(record.backend))) fields.backend = record.backend;
  const codes = ["ENOENT", "EACCES", "ETIMEDOUT", "CANCELLED", "OUTPUT_LIMIT", "PROCESS_ERROR", "MALFORMED_OUTPUT", "BACKEND_ERROR", "PERMISSION_ERROR"];
  if (typeof record.code === "string") fields.code = codes.includes(record.code) ? record.code : "BACKEND_ERROR";
  if (Array.isArray(record.steps)) fields.steps = record.steps.map(redactTypeDiagnostics);
  if (typeof record.adapter === "string") { fields.adapter = "adapter"; fields.result = redactTypeDiagnostics(record.result); }
  if (looksLikePermissionFailure(value)) fields.permissionError = "PERMISSION_ERROR";
  return fields;
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

export async function prepareComputerUseRequest(rawParams: unknown, ctx: ComputerUsePolicyContext = {}) {
  let params = normalizeParams(rawParams);
  const action = normalizeComputerUseAction(params.action);
  if (["file-list", "file-read", "file-write"].includes(action) || (["inspect", "screenshot"].includes(action) && params.path)) {
    const workspaceDir = ctx.workspaceDir ? await realpath(ctx.workspaceDir) : undefined;
    const requested = resolve(workspaceDir ?? process.cwd(), params.path ?? workspaceDir ?? ".");
    const canonical = await canonicalTarget(requested);
    // The hook carries the canonical path into execution. A changed parent cannot reuse its approval.
    params = { ...params, path: canonical, ...(params.confirm === true && requested !== canonical ? { confirm: false } : {}) };
    return { params, decision: classifyComputerUseRequest(params, { ...ctx, workspaceDir }) };
  }
  return { params, decision: classifyComputerUseRequest(params, ctx) };
}

async function canonicalTarget(target: string, workspaceDir?: string): Promise<string> {
  const absolute = resolve(workspaceDir ?? process.cwd(), target);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalTarget(parent), relative(parent, absolute));
  }
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
