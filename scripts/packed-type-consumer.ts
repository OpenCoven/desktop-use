import { createDesktopClient, resolveActionPermissions, desktopExecutionContractV1, type DesktopRequest, type DesktopResult, type DesktopRequestV1, type DesktopResultV1 } from '@opencoven/openclaw-desktop-use/sdk';
import { CANONICAL_ACTIONS, desktopRequestSchemaV1, desktopResultSchemaV1, type CanonicalAction, type DesktopResultV1 as ContractResult } from '@opencoven/openclaw-desktop-use/contracts';
const action: CanonicalAction = CANONICAL_ACTIONS[0];
const request: DesktopRequest = { action };
const client = createDesktopClient({ workspaceDir: '/tmp', scope: { principalId: 'type-consumer' }, adapterPath: '/missing/adapter', actionPermissions: resolveActionPermissions({ actionProfile: 'observation-only' }), auditSink: async event => { const status: string = event.result.status; void status; } });
const result: Promise<DesktopResult> = client.execute(request, { callId: 'typed' }); void result;
const version: 1 = desktopExecutionContractV1.version; void version;
const versioned: DesktopRequestV1 = request; void versioned;
const versionedResult: Promise<DesktopResultV1 & ContractResult> = result; void versionedResult;
void desktopRequestSchemaV1; void desktopResultSchemaV1;
// @ts-expect-error Public requests cannot carry approval authority.
const forbidden: DesktopRequest = { action: 'click', confirm: true }; void forbidden;
// @ts-expect-error The v1 status vocabulary cannot silently accept a future outcome.
const wrongStatus: DesktopResultV1 = { content: [{ type: 'text', text: '{}' }], details: { status: 'invented-outcome' } }; void wrongStatus;
