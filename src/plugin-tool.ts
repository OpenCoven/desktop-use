import { permissionToolSchema } from "./openclaw/input.js";
import { normalizeComputerUseAction, type ComputerUseParams } from "./computer-use-policy.js";
import { COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME } from "./tool-names.js";
import { CANONICAL_ACTIONS } from "./computer-use-actions.js";
import { createExecution, normalizeParams, type ExecutionOptions } from './core/execution.js';
import { resolveActionPermissions, validateActionPermissions } from './action-permissions.js';
import { appendComputerUseAuditEvent, resolveComputerUseAuditLogPath } from './openclaw/state-paths.js';
import { CONTINUATION_FIELD, type GatewayApprovalBridge } from './openclaw/approval.js';
export { normalizeParams, prepareComputerUseRequest } from './core/execution.js';

export type CreateComputerUseToolOptions = Omit<ExecutionOptions, 'appendAuditEvent' | 'surface' | 'auditLogPath'> & {
  appendAuditEvent?: ExecutionOptions['appendAuditEvent'];
  approvalBridge?: GatewayApprovalBridge;
};

function createTool(options: CreateComputerUseToolOptions, legacy = false) {
  options = { ...options };
  const ctx = Object.freeze({ ...options.ctx });
  const actionPermissions = options.actionPermissions === undefined ? resolveActionPermissions() : validateActionPermissions(options.actionPermissions);
  const coreOptions = { ...options, ctx, actionPermissions, surface: 'plugin' as const,
    appendAuditEvent: options.appendAuditEvent ?? (event => appendComputerUseAuditEvent(event, ctx)),
    auditLogPath: resolveComputerUseAuditLogPath(ctx) } satisfies ExecutionOptions;
  const permissionDescription = actionPermissions.allowedActions.length === CANONICAL_ACTIONS.length ? ""
    : actionPermissions.allowedActions.length === 1 ? " Stop-only: cancels active work in the same trusted scope without approval."
    : ` Trusted ${actionPermissions.profile} action eligibility: ${actionPermissions.allowedActions.join(", ")}. Existing approval requirements still apply.`;
  return { name: legacy ? DESKTOP_USE_TOOL_NAME : COMPUTER_USE_TOOL_NAME, label: legacy ? "Desktop Use" : "Computer Use",
    description: legacy ? `Deprecated alias for ${COMPUTER_USE_TOOL_NAME}. Use ${COMPUTER_USE_TOOL_NAME} instead. Removal targeted at 0.2.0.${permissionDescription}`
      : `OpenCoven computer-use agent tool for health checks, observation, approved desktop input, scoped shell/file actions, browser/app launches, and clipboard workflows.${permissionDescription}`,
    parameters: permissionToolSchema(actionPermissions), async execute(callId: string, raw: unknown, signal?: AbortSignal) {
    let reference: unknown;
    let clean = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, CONTINUATION_FIELD)) {
      const copy = { ...raw } as Record<string, unknown>;
      reference = copy[CONTINUATION_FIELD]; delete copy[CONTINUATION_FIELD]; clean = copy;
    }
    const params = normalizeParams(clean);
    const provider = reference === undefined ? options.approvalProvider : options.approvalBridge?.provider(reference, ctx, actionPermissions);
    const canonical = { ...params, action: normalizeComputerUseAction(params.action) } as ComputerUseParams;
    const notices: string[] = [];
    if (legacy) notices.push(`${DESKTOP_USE_TOOL_NAME} is deprecated; use ${COMPUTER_USE_TOOL_NAME} instead.`);
    if (params.action !== canonical.action) notices.push(`${params.action} is deprecated; use ${canonical.action} instead.`);
    if (canonical.action === "clipboard-write" && params.text !== undefined) {
      canonical.clipboardText = params.clipboardText ?? params.text; delete canonical.text;
      notices.push("clipboard-write text is deprecated; use clipboardText instead.");
    }
    const result = await createExecution({ ...coreOptions, approvalProvider: provider }).execute(callId, canonical, signal);
    if (notices.length) { result.details.deprecation = notices.join(" "); result.content[0].text = JSON.stringify(result.details, null, 2); }
    return result;
  } };
}
export function createComputerUseTool(options: CreateComputerUseToolOptions = {}) { return createTool(options); }
export function createDesktopUseTool(options: CreateComputerUseToolOptions = {}) { return createTool(options, true); }
