import path from "node:path";

const MAX_APPROVAL_INPUT_BYTES = 2_000;
const SECRET_PATH_RE = /(^|\/|\\)(\.ssh|\.gnupg|keychain|secrets?|credentials?|id_rsa|id_ed25519|auth\.json|auth-profiles\.json|token)(\/|\\|$)/i;
const TOKEN_VALUE_RE = /\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{8,}|[a-z0-9+/]{32,}={0,2})\b/i;

export type ComputerUseRisk =
  | "observe"
  | "local-nondestructive"
  | "local-destructive"
  | "external-visible"
  | "privileged"
  | "secret-sensitive";

export type ComputerUseDecisionStatus = "allow" | "needsApproval" | "blocked";

export type ComputerUseAction =
  | "health"
  | "stop"
  | "doctor"
  | "inspect"
  | "screenshot"
  | "click"
  | "type-text"
  | "keypress"
  | "scroll"
  | "focus"
  | "shell"
  | "file-list"
  | "file-read"
  | "file-write"
  | "clipboard-read"
  | "clipboard-write"
  | "browser-open"
  | "app-launch"
  | "permissions"
  | "see"
  | "capture"
  | "type"
  | "press";

export type ComputerUseParams = {
  action: ComputerUseAction;
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
  command?: string;
  args?: string[];
  cwd?: string;
  content?: string;
  url?: string;
  clipboardText?: string;
  includeText?: boolean;
  reason?: string;
  overwrite?: boolean;
};

export type ComputerUsePolicyContext = {
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
};

export type ComputerUseApprovalPrompt = {
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  action: string;
  target: string;
  risk: ComputerUseRisk;
  exactInput?: string;
  rollback?: string;
};

export type ComputerUseDecision = {
  status: ComputerUseDecisionStatus;
  risk: ComputerUseRisk;
  requiresApproval: boolean;
  reason?: string;
  normalizedAction: string;
  target: string;
  approvalPrompt?: ComputerUseApprovalPrompt;
};

export type NormalizedAdapterResult = {
  status: "success" | "blocked" | "needsApproval" | "unsupported" | "error";
  success: boolean;
  evidence: Record<string, unknown>;
  result: unknown;
};

const INTERACTIVE_ACTIONS = new Set(["click", "type-text", "keypress", "scroll", "focus"]);
const OBSERVE_ACTIONS = new Set(["health", "stop", "doctor", "inspect", "screenshot"]);
const FILE_READ_ACTIONS = new Set(["file-list", "file-read"]);

export function normalizeComputerUseAction(action: ComputerUseParams["action"]): string {
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

export function classifyComputerUseRequest(
  params: ComputerUseParams,
  ctx: ComputerUsePolicyContext = {},
): ComputerUseDecision {
  const action = normalizeComputerUseAction(params.action);
  if (!action) {
    return blocked("observe", action, "unknown", "Missing computer-use action.");
  }

  if (OBSERVE_ACTIONS.has(action)) {
    return allow("observe", action, describeTarget(params, ctx));
  }

  if (INTERACTIVE_ACTIONS.has(action) || action === "app-launch") {
    return approvalDecision({
      action,
      risk: "local-nondestructive",
      target: describeTarget(params, ctx),
      approved: params.confirm === true,
      reason: "Desktop input and app focus can change local machine state.",
      title: titleForAction(action),
      exactInput: exactInputForParams(params),
    });
  }

  if (action === "browser-open") {
    const target = params.url ?? params.path ?? "browser";
    const local = isLocalUrl(target);
    return approvalDecision({
      action,
      risk: local ? "local-nondestructive" : "external-visible",
      target,
      approved: params.confirm === true || local,
      reason: local
        ? "Opening a local browser target is a local action."
        : "Opening a remote URL is externally visible.",
      title: "Open Browser",
      exactInput: target,
    });
  }

  if (action === "shell") {
    return classifyShell(params, ctx);
  }

  if (FILE_READ_ACTIONS.has(action)) {
    const target = params.path ?? ctx.workspaceDir ?? ".";
    const sensitive = isSensitivePath(target) || isOutsideWorkspace(target, ctx.workspaceDir);
    return approvalDecision({
      action,
      risk: sensitive ? "secret-sensitive" : "observe",
      target,
      approved: params.confirm === true || !sensitive,
      reason: sensitive
        ? "Reading this path is privacy-sensitive or outside the configured workspace."
        : "Workspace-scoped file reads are observation actions.",
      title: action === "file-list" ? "List Files" : "Read File",
      exactInput: target,
    });
  }

  if (action === "file-write") {
    const target = params.path ?? ".";
    const sensitive = isSensitivePath(target) || isOutsideWorkspace(target, ctx.workspaceDir);
    return approvalDecision({
      action,
      risk: sensitive ? "secret-sensitive" : "local-destructive",
      target,
      approved: params.confirm === true,
      reason: sensitive
        ? "Writing this path is outside the configured workspace or may touch secrets."
        : "File writes change local workspace state.",
      title: "Write File",
      exactInput: summarizeWriteInput(params),
      rollback: "Restore the previous file content from version control or backup.",
    });
  }

  if (action === "clipboard-read" || action === "clipboard-write") {
    return approvalDecision({
      action,
      risk: "secret-sensitive",
      target: "clipboard",
      approved: params.confirm === true,
      reason: "Clipboard content may contain private data and writes can overwrite user state.",
      title: action === "clipboard-read" ? "Read Clipboard" : "Write Clipboard",
      exactInput: action === "clipboard-write" ? textByteSummary(params.clipboardText ?? params.text ?? "") : undefined,
      rollback: action === "clipboard-write" ? "Restore the previous clipboard content if it was captured before writing." : undefined,
    });
  }

  return blocked("local-nondestructive", action, describeTarget(params, ctx), `Unsupported action: ${action}.`);
}

function classifyShell(params: ComputerUseParams, ctx: ComputerUsePolicyContext): ComputerUseDecision {
  const command = (params.command ?? "").trim();
  const args = params.args ?? [];
  const preview = [command, ...args].filter(Boolean).join(" ");
  const target = params.cwd ?? ctx.workspaceDir ?? ".";
  if (!command) {
    return blocked("local-nondestructive", "shell", target, "shell requires command.");
  }
  const lowerCommand = command.toLowerCase();
  const lowerPreview = preview.toLowerCase();
  if (isSecurityBoundaryBypass(lowerCommand, lowerPreview)) {
    return blocked(
      "privileged",
      "shell",
      target,
      "Blocked attempt to bypass or reset an OS security boundary.",
    );
  }
  if (isDangerousShell(lowerCommand, lowerPreview)) {
    return blocked("privileged", "shell", target, "Blocked privileged or destructive shell command.");
  }
  if (args.some((arg) => isSensitivePath(arg))) {
    return approvalDecision({
      action: "shell",
      risk: "secret-sensitive",
      target,
      approved: params.confirm === true,
      reason: "The command references a secret-sensitive path.",
      title: "Run Shell Command",
      exactInput: bounded(preview),
    });
  }
  if (isPackageInstall(lowerCommand, lowerPreview)) {
    return approvalDecision({
      action: "shell",
      risk: "privileged",
      target,
      approved: params.confirm === true,
      reason: "Package installs and global tool changes require explicit approval.",
      title: "Run Package Install",
      exactInput: bounded(preview),
      rollback: "Uninstall the package or restore the prior lockfile/environment.",
    });
  }
  if (isExternalVisibleShell(lowerCommand, lowerPreview)) {
    return approvalDecision({
      action: "shell",
      risk: "external-visible",
      target,
      approved: params.confirm === true,
      reason: "This command can contact or mutate an external service.",
      title: "Run External Shell Command",
      exactInput: bounded(preview),
    });
  }
  if (isOutsideWorkspace(target, ctx.workspaceDir)) {
    return approvalDecision({
      action: "shell",
      risk: "secret-sensitive",
      target,
      approved: params.confirm === true,
      reason: "Shell cwd is outside the configured computer-use workspace.",
      title: "Run Shell Command Outside Workspace",
      exactInput: bounded(preview),
    });
  }
  return allow("local-nondestructive", "shell", target);
}

function allow(risk: ComputerUseRisk, action: string, target: string): ComputerUseDecision {
  return {
    status: "allow",
    risk,
    requiresApproval: false,
    normalizedAction: action,
    target,
  };
}

function blocked(
  risk: ComputerUseRisk,
  action: string,
  target: string,
  reason: string,
): ComputerUseDecision {
  return {
    status: "blocked",
    risk,
    requiresApproval: false,
    reason,
    normalizedAction: action,
    target,
  };
}

function approvalDecision(params: {
  action: string;
  risk: ComputerUseRisk;
  target: string;
  approved: boolean;
  reason: string;
  title: string;
  exactInput?: string;
  rollback?: string;
}): ComputerUseDecision {
  if (params.approved) {
    return allow(params.risk, params.action, params.target);
  }
  return {
    status: "needsApproval",
    risk: params.risk,
    requiresApproval: true,
    reason: params.reason,
    normalizedAction: params.action,
    target: params.target,
    approvalPrompt: {
      title: params.title,
      description: [
        params.reason,
        `Target: ${params.target}.`,
        params.exactInput ? `Exact input: ${bounded(params.exactInput)}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      severity: params.risk === "privileged" || params.risk === "secret-sensitive" ? "critical" : "warning",
      action: params.action,
      target: params.target,
      risk: params.risk,
      ...(params.exactInput ? { exactInput: bounded(params.exactInput) } : {}),
      ...(params.rollback ? { rollback: params.rollback } : {}),
    },
  };
}

function titleForAction(action: string): string {
  switch (action) {
    case "click":
      return "Click Desktop Target";
    case "type-text":
      return "Type Text";
    case "keypress":
      return "Press Keys";
    case "scroll":
      return "Scroll";
    case "focus":
      return "Focus App or Window";
    case "app-launch":
      return "Launch App";
    default:
      return action;
  }
}

function describeTarget(params: ComputerUseParams, ctx: ComputerUsePolicyContext): string {
  if (params.app) {
    const targetParts = [params.app];
    if (params.windowTitle) targetParts.push(params.windowTitle);
    if (params.on) targetParts.push(params.on);
    if (params.query) targetParts.push(params.query);
    if (params.coords) targetParts.push(params.coords);
    return targetParts.join(" - ");
  }
  if (params.windowTitle) return params.windowTitle;
  if (params.windowId !== undefined) return `window:${params.windowId}`;
  if (params.on) return params.on;
  if (params.query) return params.query;
  if (params.coords) return params.coords;
  if (params.path) return params.path;
  if (params.url) return params.url;
  return ctx.workspaceDir ?? "local machine";
}

function exactInputForParams(params: ComputerUseParams): string | undefined {
  const redacted = redactComputerUseValue(params);
  return bounded(JSON.stringify(redacted));
}

function summarizeWriteInput(params: ComputerUseParams): string {
  return `${params.path ?? "unknown path"} ${textByteSummary(params.content ?? "")}`;
}

function textByteSummary(value: string): string {
  return `<${Buffer.byteLength(value, "utf8")}-byte text>`;
}

function bounded(value: string): string {
  return Buffer.byteLength(value, "utf8") > MAX_APPROVAL_INPUT_BYTES
    ? `${value.slice(0, MAX_APPROVAL_INPUT_BYTES)}...<truncated>`
    : value;
}

function isSecurityBoundaryBypass(command: string, preview: string): boolean {
  return (
    command === "tccutil" ||
    preview.includes("privacy_accessibility") ||
    preview.includes("privacy_screencapture") ||
    preview.includes("disable gatekeeper") ||
    preview.includes("spctl --master-disable") ||
    preview.includes("authorizationdb write")
  );
}

function isDangerousShell(command: string, preview: string): boolean {
  return (
    command === "sudo" ||
    command === "su" ||
    command === "doas" ||
    command === "launchctl" ||
    command === "security" ||
    /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(\/|~|\$HOME)\b/.test(preview) ||
    /\bdd\s+if=/.test(preview) ||
    /\bmkfs\b/.test(preview) ||
    /\bchmod\s+-r\s+777\s+(\/|~|\$HOME)\b/.test(preview)
  );
}

function isPackageInstall(command: string, preview: string): boolean {
  return (
    (["npm", "pnpm", "yarn", "bun"].includes(command) &&
      /\b(add|install|i|dlx|exec)\b/.test(preview)) ||
    (["pip", "pip3", "uv", "cargo", "gem"].includes(command) && /\binstall\b/.test(preview)) ||
    (command === "brew" && /\b(install|upgrade|tap)\b/.test(preview)) ||
    (["apt", "apt-get", "yum", "dnf"].includes(command) && /\binstall\b/.test(preview))
  );
}

function isExternalVisibleShell(command: string, preview: string): boolean {
  return (
    ["curl", "wget", "ssh", "scp", "rsync"].includes(command) ||
    (command === "git" && /\b(push|fetch|pull|clone)\b/.test(preview)) ||
    (command === "gh" && /\b(pr\s+merge|release|api|repo|issue\s+comment)\b/.test(preview))
  );
}

function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isSensitivePath(value: string): boolean {
  return SECRET_PATH_RE.test(value);
}

function isOutsideWorkspace(target: string, workspaceDir: string | undefined): boolean {
  if (!workspaceDir || !target.trim() || !path.isAbsolute(target)) {
    return false;
  }
  const relative = path.relative(path.resolve(workspaceDir), path.resolve(target));
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export function redactComputerUseValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactComputerUseValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactComputerUseValue(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value !== "string") {
    return value;
  }
  const lowered = key.toLowerCase();
  if (
    lowered.includes("password") ||
    lowered.includes("token") ||
    lowered.includes("secret") ||
    lowered.includes("apikey") ||
    lowered.includes("api_key") ||
    lowered.includes("authorization") ||
    lowered.includes("cookie")
  ) {
    return "<redacted>";
  }
  if (["text", "clipboardtext", "content"].includes(lowered)) {
    return textByteSummary(value);
  }
  return TOKEN_VALUE_RE.test(value) ? "<redacted>" : value;
}

export function normalizeAdapterResult(
  result: unknown,
  options: { evidence: Record<string, unknown> },
): NormalizedAdapterResult {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (record.supported === false) {
    return {
      status: "unsupported",
      success: false,
      evidence: options.evidence,
      result,
    };
  }
  if (record.ok === true) {
    return {
      status: "success",
      success: true,
      evidence: options.evidence,
      result,
    };
  }
  return {
    status: "error",
    success: false,
    evidence: options.evidence,
    result,
  };
}
