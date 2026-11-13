import { COMPUTER_USE_TOOL_NAME } from "./tool-names.js";
import { readFileSync } from "node:fs";
import { CANONICAL_ACTIONS, type CanonicalAction } from "./computer-use-actions.js";
import { validateActionPermissions, type ActionPermissions } from "./action-permissions.js";

type State = "available" | "degraded" | "unsupported" | "unverified";
type Provider = { name: string; version: string | null };
type Parameter = { values?: (string | number | boolean | null)[]; minimum?: number; maximum?: number; maxBytes?: number; maxWidth?: number; maxHeight?: number; maxPixels?: number; maxDecodedBytes?: number; units?: string; encoding?: string; knowledge?: "known" | "unknown" };
type Variant = { mode: "screen" | "window" | "frontmost" | null; selectors: string[]; provider: Provider; limits: { constraints: string[]; parameters: Record<string, Parameter> }; state: State; reasonCodes: string[] };
type Evidence = { kind: "implementation" | "binary" | "protocol" | "permission" | "geometry" | "actual-action"; status: "passed" | "failed" | "unknown" | "not-run"; scope: string; provider?: Provider; observedAtMs?: number };
type Action = { surfaces: ("cli" | "plugin" | "sdk" | "mcp")[]; state: State; reasonCodes: string[]; variants: Variant[]; evidence: Evidence[]; policy: { profile: "allowed" | "denied" | "unknown"; approval: "none" | "required" | "request-dependent" | "unknown"; gatewayPolicy: "not-reported" } };
export type CapabilityReportV1 = {
  schemaVersion: 1;
  producer: { name: string; version: string; surface: "cli" | "plugin" | "sdk" | "mcp" };
  environment: { platform: "macos" | "linux" | "windows" | "other"; session: "x11" | "wayland" | null };
  actions: Record<CanonicalAction, Action>;
  adapter?: { configuredPath: string; resolvedPath: string | null; version: string | null };
  actionPermissions?: { profile: string; allowedActions: readonly CanonicalAction[]; snapshotId: string };
};
export type HostEvidence = {
  environment: CapabilityReportV1["environment"];
  adapter: { configuredPath: string; resolvedPath: string | null };
  integrations: Partial<Record<"clipboard-read" | "clipboard-write" | "browser-open" | "app-launch", { state: State; reasonCodes: string[]; provider?: Provider; binary?: { status: "passed" | "failed" | "unknown"; observedAtMs?: number } }>>;
  observedAtMs?: number;
};
export type CapabilityOutcome = { phase: "before-start" | "spawn" | "process" | "output" | "adapter"; processStarted?: boolean; code?: string; setupGuide?: boolean; permissionDenied?: boolean };

const schema = JSON.parse(readFileSync(new URL("../contracts/v1/capabilities.schema.json", import.meta.url), "utf8"));
const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// The bundled contract uses this bounded JSON Schema subset. Runtime needs only Node;
// Ajv remains a development cross-validator, never a private host dependency.
function matches(value: unknown, rule: any, depth = 0): boolean {
  if (depth > 30) return false;
  if (rule.$ref) return matches(value, schema.$defs[rule.$ref.split("/").at(-1)], depth + 1);
  if (rule.anyOf && !rule.anyOf.some((r: any) => matches(value, r, depth + 1))) return false;
  if ("const" in rule && !same(value, rule.const)) return false;
  if (rule.enum && !rule.enum.some((item: unknown) => same(value, item))) return false;
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.some((type: string) => type === "null" ? value === null : type === "object" ? object(value) : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type)) return false;
  }
  if (typeof value === "string" && ((rule.minLength !== undefined && [...value].length < rule.minLength) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) return false;
  if (typeof value === "number" && ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) return false;
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) return false;
    if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    if (rule.items && !value.every(item => matches(item, rule.items, depth + 1))) return false;
  }
  if (object(value)) {
    if (rule.required?.some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(rule.properties ?? {}, key)) { if (!matches(item, rule.properties[key], depth + 1)) return false; }
      else if (rule.additionalProperties === false) return false;
      else if (object(rule.additionalProperties) && !matches(item, rule.additionalProperties, depth + 1)) return false;
    }
  }
  return true;
}

export function normalizeCapabilityReport(value: unknown): CapabilityReportV1 {
  if (!object(value) || value.schemaVersion !== 1) throw new Error("CAPABILITY_SCHEMA_UNSUPPORTED: capability schema version is not supported.");
  if (!matches(value, schema)) throw new Error("CAPABILITY_SCHEMA_INVALID: capability report does not match v1.");
  return structuredClone(value) as CapabilityReportV1;
}

const adapterActions = new Set<CanonicalAction>(["doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus"]);
const integrations = new Set<CanonicalAction>(["clipboard-read", "clipboard-write", "browser-open", "app-launch"]);
const requiredApproval = new Set<CanonicalAction>(["click", "type-text", "keypress", "scroll", "focus", "shell", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch"]);
function approval(action: CanonicalAction): Action["policy"]["approval"] {
  return requiredApproval.has(action) ? "required" : ["inspect", "screenshot", "file-list", "file-read"].includes(action) ? "request-dependent" : "none";
}
function localAction(action: CanonicalAction, host: HostEvidence): Action {
  const integration = integrations.has(action) ? host.integrations[action as keyof HostEvidence["integrations"]] : undefined;
  const state = integrations.has(action) ? integration?.state ?? "unverified" : "available";
  const provider = integration?.provider ?? { name: "opencoven-desktop-use-plugin", version };
  const parameters: Record<string, Parameter> = { timeoutMs: { minimum: 1000, maximum: 120000, units: "milliseconds" } };
  const constraints: string[] = [];
  if (action.startsWith("file-")) { parameters.path = { maxBytes: 2048, encoding: "utf-8" }; constraints.push("CANONICAL_TARGET_REQUIRED", "OUTSIDE_WORKSPACE_REQUIRES_APPROVAL"); }
  if (action === "file-read") { parameters.file = { maxBytes: 1048576 }; parameters.includeText = { values: [false, true] }; }
  if (action === "file-write") parameters.content = { maxBytes: 100000, encoding: "utf-8" };
  if (action === "shell") { parameters.command = { maxBytes: 2048, encoding: "utf-8" }; parameters.args = { maxBytes: 2048, units: "bytes-per-argument", encoding: "utf-8" }; constraints.push("NO_SHELL_INTERPOLATION", "DANGEROUS_COMMANDS_BLOCKED"); }
  if (action === "clipboard-write") parameters.clipboardText = { maxBytes: 100000, encoding: "utf-8" };
  if (action === "clipboard-read") parameters.includeText = { values: [false, true] };
  if (action === "browser-open") { parameters.url = { maxBytes: 2048, encoding: "utf-8" }; constraints.push("HTTP_HTTPS_ONLY", "URL_CREDENTIALS_FORBIDDEN", "HANDOFF_ONLY"); }
  if (action === "app-launch") { parameters.app = { maxBytes: 2048, encoding: "utf-8" }; constraints.push("INSTALLED_APPLICATION_REQUIRED", "HANDOFF_ONLY"); }
  return { surfaces: ["plugin"], state, reasonCodes: integration?.reasonCodes ?? (integrations.has(action) ? ["HOST_PREREQUISITES_UNKNOWN"] : []), variants: ["health", "stop"].includes(action) ? [] : [{ mode: null, selectors: [], provider, limits: { constraints, parameters }, state, reasonCodes: integration?.reasonCodes ?? (integrations.has(action) ? ["HOST_PREREQUISITES_UNKNOWN"] : []) }], evidence: [
    { kind: "implementation", status: "passed", scope: action === "stop" ? "same-trusted-agent-session-workspace-cancellation" : "plugin-host-dispatch", provider },
    ...(integrations.has(action) ? [{ kind: "binary" as const, status: integration?.binary?.status ?? "unknown" as const, scope: "host-helper-inventory-only", ...(integration?.provider ? { provider: integration.provider } : {}), ...(integration?.binary?.observedAtMs === undefined ? {} : { observedAtMs: integration.binary.observedAtMs }) }] : []),
    { kind: "actual-action", status: "not-run", scope: "no-action-during-discovery", provider },
  ], policy: { profile: "unknown", approval: approval(action), gatewayPolicy: "not-reported" } };
}

/** Adapter JSON supplies observations only; eligibility comes from a private-origin host snapshot. */
export function buildPluginCapabilities(adapterEnvelope: unknown, hostEvidence: HostEvidence, actionPermissions: ActionPermissions): CapabilityReportV1 {
  const permissions = validateActionPermissions(actionPermissions);
  const value = object(adapterEnvelope) ? adapterEnvelope.capabilitiesV1 : undefined;
  const adapter = value === undefined ? undefined : normalizeCapabilityReport(value);
  if (adapter && adapter.producer.surface !== "cli") throw new Error("CAPABILITY_SCHEMA_INVALID: expected an adapter CLI report.");
  const actions = {} as Record<CanonicalAction, Action>;
  for (const action of CANONICAL_ACTIONS) {
    const source = adapter?.actions[action];
    const capability: Action = adapterActions.has(action) ? source ? { ...source, surfaces: source.surfaces.filter(surface => surface === "cli" || surface === "plugin"), state: source.surfaces.includes("plugin") ? source.state : "unsupported" } : {
      surfaces: ["cli", "plugin"], state: "unverified", reasonCodes: ["ADAPTER_CAPABILITIES_NOT_REPORTED"], variants: [],
      evidence: [{ kind: "implementation", status: "unknown", scope: "adapter-capabilities-not-reported" }, { kind: "actual-action", status: "not-run", scope: "no-action-during-discovery" }],
      policy: { profile: "unknown", approval: "unknown", gatewayPolicy: "not-reported" },
    } : localAction(action, hostEvidence);
    // No SDK/MCP claims survive the plugin overlay, even if supplied by adapter JSON.
    capability.surfaces = capability.surfaces.filter(surface => surface === "cli" || surface === "plugin");
    capability.policy = { profile: permissions.allowedActions.includes(action) ? "allowed" : "denied", approval: approval(action), gatewayPolicy: "not-reported" };
    actions[action] = capability;
  }
  return { schemaVersion: 1, producer: { name: "opencoven-desktop-use-plugin", version, surface: "plugin" }, environment: adapter?.environment ?? hostEvidence.environment, actions,
    adapter: { ...hostEvidence.adapter, version: adapter?.producer.version ?? null },
    actionPermissions: { profile: permissions.profile, allowedActions: [...permissions.allowedActions], snapshotId: permissions.snapshotId } };
}

/** Fixed guidance never interpolates backend diagnostics or private request content. */
export function repairHintsForCapabilities(report: CapabilityReportV1, outcome: CapabilityOutcome): string[] {
  if (outcome.phase === "before-start") return ["The adapter request ended before a process started. No adapter execution was observed."];
  if (outcome.phase === "process") return ["The adapter process did not complete. Inspect its fixed outcome code and any partial progress before deciding whether to retry."];
  if (outcome.phase === "spawn") {
    if (outcome.code === "ENOENT") return [`The selected adapter could not be started. Install coven-desktop-use or correct COVEN_DESKTOP_USE_BIN, then restart the OpenClaw Gateway and rerun ${COMPUTER_USE_TOOL_NAME} action=health.`];
    if (["EACCES", "EPERM"].includes(outcome.code ?? "")) return [`The selected adapter could not be executed. Check its executable access and the gateway service account, then rerun ${COMPUTER_USE_TOOL_NAME} action=health.`];
    return [`The adapter process did not complete. Inspect its fixed outcome code before retrying ${COMPUTER_USE_TOOL_NAME} action=health.`];
  }
  if (outcome.phase === "output") return [`The selected adapter returned an incompatible or malformed discovery response. Use an adapter with capability schema v1, then rerun ${COMPUTER_USE_TOOL_NAME} action=health.`];
  if (report.environment.platform === "macos" && (outcome.permissionDenied || Object.values(report.actions).some(action => action.evidence.some(e => e.kind === "permission" && e.status === "failed" && e.provider?.name === "peekaboo")))) return [`Peekaboo reported missing macOS permissions. Review Screen Recording and Accessibility for the intentionally installed binaries in permissionFlow, restart the granted launcher, then rerun ${COMPUTER_USE_TOOL_NAME} action=doctor.`];
  if (report.environment.platform === "macos" && Object.values(report.actions).some(action => action.evidence.some(e => e.kind === "binary" && e.status === "failed" && e.provider?.name === "peekaboo"))) return [`The adapter ran but its Peekaboo helper is unavailable. Install or correct the Peekaboo backend, then rerun ${COMPUTER_USE_TOOL_NAME} action=doctor.`];
  if (report.environment.platform === "linux" && outcome.setupGuide && Object.values(report.actions).some(action => action.reasonCodes.includes("HELPER_MISSING") || action.variants.some(variant => variant.reasonCodes.includes("HELPER_MISSING")))) return [`Review the adapter's setupGuide for the detected Linux session and missing helpers, then rerun ${COMPUTER_USE_TOOL_NAME} action=doctor. Helper inventory does not verify daemon access, session permissions, or desktop effects.`];
  return [];
}

/** Reference consumer: UI decisions use the report, with no host-OS branches. */
export function discoverCapabilityControls(input: unknown) {
  const report = normalizeCapabilityReport(input);
  return CANONICAL_ACTIONS.map(action => {
    const capability = report.actions[action];
    const denied = capability.policy.profile !== "allowed";
    const surface = capability.surfaces.includes(report.producer.surface);
    const reasons = [...capability.reasonCodes, ...(denied ? [capability.policy.profile === "denied" ? "ACTION_PROFILE_DENIED" : "ACTION_PROFILE_UNKNOWN"] : []), ...(!surface ? ["SURFACE_UNAVAILABLE"] : [])];
    const eligible = !denied && surface && ["available", "degraded"].includes(capability.state);
    return { action, enabled: eligible && ["available", "degraded"].includes(capability.state), state: capability.state, reasonCodes: reasons, approval: capability.policy.approval, gatewayPolicy: capability.policy.gatewayPolicy,
      variants: capability.variants.map(variant => ({ mode: variant.mode, selectors: variant.selectors, provider: variant.provider, parameters: variant.limits.parameters, constraints: variant.limits.constraints, state: variant.state, enabled: eligible && ["available", "degraded"].includes(variant.state), reasonCodes: [...reasons, ...variant.reasonCodes] })) };
  });
}
