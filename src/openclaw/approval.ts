import { randomUUID } from 'node:crypto';
import { activeCalls, canonicalTarget } from '../core/execution.js';
import { immutableParams, DEFAULT_APPROVAL_TIMEOUT_MS, type ApprovalProvider } from '../core/approval.js';
import { normalizeComputerUseAction, type ComputerUseParams, type ComputerUsePolicyContext } from '../computer-use-policy.js';
import { computerUseScopeKey } from '../computer-use-scope.js';
import type { ActionPermissions } from '../action-permissions.js';

export const CONTINUATION_FIELD = '_desktopApproval';
const fingerprint = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
type Entry = { workspaceBinding?: string; params: ComputerUseParams; scope: string; snapshotId: string; state: 'pending' | 'allowed'; expiresAt: number; controller: AbortController; timer: ReturnType<typeof setTimeout> };

/** Per-registration private grants; public requests and returned params never grant authority. */
export function createGatewayApprovalBridge(timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
  const entries = new Map<string, Entry>();
  const drop = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); clearTimeout(entry.timer);
    const calls = activeCalls.get(entry.scope); calls?.delete(entry.controller);
    if (!calls?.size) activeCalls.delete(entry.scope);
  };
  return {
    async prepare(params: ComputerUseParams, ctx: ComputerUsePolicyContext, permissions: ActionPermissions) {
      const workspaceBinding = ctx.workspaceDir ? await canonicalTarget(ctx.workspaceDir) : undefined;
      while (entries.size >= 256) drop(entries.keys().next().value!);
      const id = randomUUID(), controller = new AbortController(), scope = computerUseScopeKey(ctx, 'call');
      const clean = { ...params, action: normalizeComputerUseAction(params.action) } as ComputerUseParams; delete clean.confirm;
      if (clean.action === 'clipboard-write' && clean.text !== undefined) { clean.clipboardText = clean.clipboardText ?? clean.text; delete clean.text; }
      const timer = setTimeout(() => drop(id), timeoutMs); timer.unref();
      const entry: Entry = { workspaceBinding, params: immutableParams(clean), scope, snapshotId: permissions.snapshotId, state: 'pending', expiresAt: Date.now() + timeoutMs, controller, timer };
      entries.set(id, entry);
      const calls = activeCalls.get(scope) ?? new Set<AbortController>(); calls.add(controller); activeCalls.set(scope, calls);
      controller.signal.addEventListener('abort', () => drop(id), { once: true });
      return {
        params: { ...params, [CONTINUATION_FIELD]: id },
        onResolution(resolution: string) {
          if (entries.get(id) !== entry || entry.state !== 'pending') return;
          if ((resolution === 'allow-once' || resolution === 'allow-always') && !controller.signal.aborted && Date.now() < entry.expiresAt) entry.state = 'allowed';
          else drop(id);
        },
      };
    },
    provider(id: unknown, ctx: ComputerUsePolicyContext, permissions: ActionPermissions): ApprovalProvider {
      return challenge => {
        const entry = typeof id === 'string' ? entries.get(id) : undefined;
        if (!entry) return 'unavailable';
        // Any attempted consumption burns the private entry, including mismatches.
        drop(id as string);
        if (entry.state !== 'allowed' || entry.controller.signal.aborted || challenge.signal.aborted || Date.now() >= entry.expiresAt) return 'unavailable';
        if (entry.workspaceBinding !== challenge.workspaceDir || entry.scope !== computerUseScopeKey(ctx, 'call') || entry.snapshotId !== permissions.snapshotId || challenge.policy.snapshotId !== entry.snapshotId || fingerprint(challenge.params) !== fingerprint(entry.params)) return 'unavailable';
        return 'allowed';
      };
    },
  };
}
export type GatewayApprovalBridge = ReturnType<typeof createGatewayApprovalBridge>;
