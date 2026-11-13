import { isAbsolute } from 'node:path';
import { CANONICAL_ACTIONS, type CanonicalAction } from '../computer-use-actions.js';
import { resolveActionPermissions, validateActionPermissions, type ActionPermissions } from '../action-permissions.js';
import type { ComputerUseParams } from '../computer-use-policy.js';
import { createExecution, normalizeParams, type AuditWriter, type ToolResult } from './execution.js';
import { DEFAULT_APPROVAL_TIMEOUT_MS, type ApprovalProvider } from './approval.js';
export type { ApprovalChallenge, ApprovalProvider, ApprovalResolution } from './approval.js';
export type { ComputerUseAuditEvent } from './audit.js';
export type DesktopRequest = Omit<ComputerUseParams, 'action' | 'confirm'> & { action: CanonicalAction };
export type DesktopResult = ToolResult;
export type DesktopClientOptions = {
  workspaceDir: string;
  scope: Readonly<{ principalId: string; sessionId?: string }>;
  adapterPath: string;
  actionPermissions?: ActionPermissions;
  auditSink: AuditWriter;
  approvalProvider?: ApprovalProvider;
  approvalTimeoutMs?: number;
};
export type DesktopClient = { execute(request: DesktopRequest, call: { callId: string; signal?: AbortSignal }): Promise<DesktopResult> };

export function createDesktopClient(options: DesktopClientOptions): DesktopClient {
  if (!options || typeof options.workspaceDir !== 'string' || !isAbsolute(options.workspaceDir) || options.workspaceDir.includes('\0')) throw new Error('An absolute trusted workspaceDir is required.');
  if (!options.scope || typeof options.scope.principalId !== 'string' || !options.scope.principalId || (options.scope.sessionId !== undefined && typeof options.scope.sessionId !== 'string')) throw new Error('A trusted principal scope is required.');
  if (typeof options.auditSink !== 'function') throw new Error('A trusted auditSink is required.');
  if (typeof options.adapterPath !== 'string' || !options.adapterPath || options.adapterPath.includes('\0')) throw new Error('A trusted adapterPath is required.');
  if (options.approvalProvider !== undefined && typeof options.approvalProvider !== 'function') throw new Error('Invalid trusted approvalProvider.');
  const timeout = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_APPROVAL_TIMEOUT_MS) throw new Error('Invalid approval timeout.');
  const permissions = options.actionPermissions === undefined ? resolveActionPermissions({ actionProfile: 'observation-only' }) : validateActionPermissions(options.actionPermissions);
  const execution = createExecution({ ctx: { workspaceDir: options.workspaceDir, agentId: options.scope.principalId, sessionKey: options.scope.sessionId }, adapterPath: options.adapterPath,
    actionPermissions: permissions, appendAuditEvent: options.auditSink, approvalProvider: options.approvalProvider, approvalTimeoutMs: timeout, surface: 'sdk' });
  return Object.freeze({ async execute(request: DesktopRequest, call: { callId: string; signal?: AbortSignal }) {
    if (!call || typeof call.callId !== 'string') throw new Error('callId is required for correlation.');
    if (!request || Object.hasOwn(request, 'confirm')) throw new Error('Request authority fields are forbidden.');
    const params = normalizeParams(request);
    if (!CANONICAL_ACTIONS.includes(params.action as CanonicalAction) || (params.action === 'clipboard-write' && params.text !== undefined)) throw new Error('Canonical request parameters are required.');
    return execution.execute(call.callId, params, call.signal);
  } });
}
