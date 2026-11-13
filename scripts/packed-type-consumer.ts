import { createDesktopClient, resolveActionPermissions, type DesktopRequest, type DesktopResult } from '@opencoven/openclaw-desktop-use/sdk';
import { CANONICAL_ACTIONS, type CanonicalAction } from '@opencoven/openclaw-desktop-use/contracts';
const action: CanonicalAction = CANONICAL_ACTIONS[0];
const request: DesktopRequest = { action };
const client = createDesktopClient({ workspaceDir: '/tmp', scope: { principalId: 'type-consumer' }, adapterPath: '/missing/adapter', actionPermissions: resolveActionPermissions({ actionProfile: 'observation-only' }), auditSink: async event => { const status: string = event.result.status; void status; } });
const result: Promise<DesktopResult> = client.execute(request, { callId: 'typed' }); void result;
// @ts-expect-error Public requests cannot carry approval authority.
const forbidden: DesktopRequest = { action: 'click', confirm: true }; void forbidden;
