# Desktop client and trusted approvals

The unpublished local candidate exposes the host-neutral `@opencoven/openclaw-desktop-use/sdk` compiled JavaScript entry with TypeScript declarations and `createDesktopClient(options)` and `client.execute(request, { callId, signal? })`. The `/contracts` export supplies the canonical action names and versioned observation, capability and action schemas. The client imports the shared policy, execution, image and capability contracts without loading OpenClaw. All 18 canonical actions use the same pipeline as the plugin.

Construction requires an absolute trusted `workspaceDir`, a scope with `principalId` and optional `sessionId`, an explicit `adapterPath`, and an `auditSink` function. Optional `actionPermissions` must originate from `resolveActionPermissions`; omitted permissions default to observation-only. An explicit trusted `approvalProvider` handles gated operations. Action eligibility never grants approval. Audit failures preserve the completed action outcome and report `AUDIT_WRITE_FAILED`.

Requests contain canonical action parameters only. They reject `confirm`, legacy action names, legacy clipboard `text`, scope/workspace overrides, provider configuration and approval receipts. `callId` is correlation only; repeating it neither grants authority nor deduplicates effects. Every execution is a new operation with its own approval challenge when needed.

An approval provider receives a frozen challenge containing server-generated operation and approval identifiers, canonical parameters and target, immutable policy snapshot, trusted scope/workspace, expiry and an AbortSignal. Return `allowed`, `denied`, `cancelled`, `expired` or `unavailable`. Provider exceptions and malformed responses fail closed without exposing their diagnostics. The default approval wait is 300000 ms, independently of the action execution timeout; trusted construction may shorten it using `approvalTimeoutMs`. Approval timeout and cancellation abort the provider signal. Never implement the provider by trusting model parameters or echoing an approval identifier.

The execution pipeline registers pending work before waiting for approval. Same-scope Stop and the call AbortSignal cancel both pending and active work. Other principals, sessions and workspaces cannot stop it. Late provider decisions do not resume cancelled or expired operations. After approval, canonical targets and workspace binding are checked again before the one execution dispatch. Caller mutations cannot change the copied request. Stop does not undo completed effects, and the existing filesystem protections do not promise isolation from a hostile concurrent writer under the same OS user.

## OpenClaw migration

The plugin retains both tool names and all existing legacy input notices. Compatibility mapping is separate from the canonical client. The public `requireApproval.onResolution` callback, called by the gateway, unlocks a private one-use continuation bound to the request, trusted scope/workspace and permissions. Returned parameters alone are insufficient. The hook rejects model-supplied continuation references; the tool removes internal references before public validation, provider challenges, action audit and final results. Pending and unused entries expire, and each registration retains at most 256 entries.

Direct calls to the exported tool factory previously could pass `confirm:true`; they now return `needsApproval` for gated operations without a trusted approval provider or continuation. The pinned gateways also route `/tools/invoke` through the public approval hook: HTTP calls can proceed only after an actual allowed gateway resolution and fail visibly on denial, expiry or an unavailable approval route. Gateway authentication and `confirm:true` alone never authorize a gated effect. Use the gateway approval flow, or a trusted standalone client whose approval provider is connected to an operator UI. Health, ordinary eligible observations and same-scope Stop remain ungated. Legacy names and `confirm` syntax remain accepted by the plugin for migration, but confirmation fields convey no authority.

The local fixture qualifier `scripts/qualify-sdk-authorization.mjs` runs the pinned gateway with a local deterministic model and harmless file/adapter fixtures. Its transparent test wrapper captures actual host invocations and injects changed parameters for negative tests; it does not grant approval. Source, packed gateway, native desktop, hosted and installed acceptance remain separate evidence classes.

## Local candidate consumption

These exports are local candidate work; the existing public npm version `0.1.2` does not establish their availability. The package version stays unchanged until the separate release decision. From this checkout, create a tarball and install that exact file into a separate application:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
mkdir -p /tmp/desktop-use-candidate
pnpm pack --pack-destination /tmp/desktop-use-candidate
# In the consuming application:
npm install /tmp/desktop-use-candidate/opencoven-openclaw-desktop-use-0.1.2.tgz
```

```ts
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { CANONICAL_ACTIONS, capabilitiesSchemaV1, observationSchemaV1 } from '@opencoven/openclaw-desktop-use/contracts';
```

Standalone SDK/MCP consumers require Node `>=22.14.0`; they need neither OpenClaw nor tsx. The supported OpenClaw extension is `dist/index.js`, declared by the package manifest. The minimum host remains `2026.4.26`; the tested newer host is `2026.11.3`, whose runtime requires Node `>=24.16.0` within 24.x (qualified here on `24.22.0`). These are compatibility lanes, not security recommendations for older runtimes.

The production archive contains compiled JavaScript/declarations, versioned runtime contracts, runtime package metadata, agent templates and public documentation. Tests, source TypeScript, fixtures and private receipts are excluded. `pnpm run test:packed` installs the actual tarball outside repository ancestors, checks SDK and declaration consumers, and drives both MCP revisions through the compiled executable and real terminal reference host. Its Python PTY driver is test infrastructure; Python is not a production dependency. Runtime graph checks traverse both source and emitted plugin/core/contracts/connector graphs, ignore type-only imports, and reject transitive undeclared or computed runtime imports.
