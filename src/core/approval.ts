import { randomUUID } from 'node:crypto';
import type { ActionPermissions } from '../action-permissions.js';
import type { ComputerUseDecision, ComputerUseParams, ComputerUsePolicyContext } from '../computer-use-policy.js';

export type ApprovalResolution = 'allowed' | 'denied' | 'cancelled' | 'expired' | 'unavailable';
export type ApprovalChallenge = Readonly<{
  operationId: string;
  approvalId: string;
  params: Readonly<Omit<ComputerUseParams, 'confirm'>>;
  target: string;
  policy: ActionPermissions;
  scope: Readonly<{ principalId: string; sessionId?: string }>;
  workspaceDir?: string;
  expiresAt: number;
  signal: AbortSignal;
}>;
export type ApprovalProvider = (challenge: ApprovalChallenge) => ApprovalResolution | Promise<ApprovalResolution>;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export function immutableParams(params: ComputerUseParams): ComputerUseParams {
  const copy = structuredClone(params);
  if (copy.args) Object.freeze(copy.args);
  if (copy.keys) Object.freeze(copy.keys);
  return Object.freeze(copy);
}

export class ApprovalFailure extends Error {
  readonly code: string;
  constructor(resolution: ApprovalResolution) {
    super('Trusted approval did not authorize this operation.');
    this.code = resolution === 'cancelled' ? 'CANCELLED' : resolution === 'expired' ? 'APPROVAL_EXPIRED' : resolution === 'denied' ? 'APPROVAL_DENIED' : 'APPROVAL_UNAVAILABLE';
  }
}

/** The provider is trusted construction, never a request field or correlation id. */
export async function requestApproval(params: ComputerUseParams, decision: ComputerUseDecision, ctx: ComputerUsePolicyContext, policy: ActionPermissions, provider: ApprovalProvider | undefined, signal: AbortSignal, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS): Promise<ApprovalResolution> {
  if (signal.aborted) return 'cancelled';
  if (!provider) return 'unavailable';
  const providerController = new AbortController();
  const challenge: ApprovalChallenge = Object.freeze({ operationId: randomUUID(), approvalId: randomUUID(), params: immutableParams(params), target: decision.target, policy,
    scope: Object.freeze({ principalId: ctx.agentId ?? 'computer-use', ...(ctx.sessionKey === undefined ? {} : { sessionId: ctx.sessionKey }) }),
    ...(ctx.workspaceDir === undefined ? {} : { workspaceDir: ctx.workspaceDir }), expiresAt: Date.now() + timeoutMs, signal: providerController.signal });
  return new Promise(resolve => {
    let finished = false;
    const finish = (value: ApprovalResolution) => {
      if (finished) return;
      finished = true; if (value !== 'allowed') providerController.abort(); clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value);
    };
    const abort = () => finish('cancelled');
    const timer = setTimeout(() => finish('expired'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { finish('cancelled'); return; }
    // Promise.resolve also normalizes synchronous exceptions and malformed providers.
    Promise.resolve().then(() => provider(challenge)).then(value => {
      if (signal.aborted) finish('cancelled');
      else if (Date.now() >= challenge.expiresAt) finish('expired');
      else finish(['allowed', 'denied', 'cancelled', 'expired', 'unavailable'].includes(value) ? value : 'unavailable');
    }, () => finish('unavailable'));
  });
}
