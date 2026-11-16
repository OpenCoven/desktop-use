# Controlled lifecycle fixtures

This namespace provides an active adapter/helper fixture for later L4 wiring in the existing harness qualifier. Each invocation runs a real child process and records a controlled readiness phase, one fixed filesystem effect and terminal state. The existing observation runner and its approval integration retain their separate ownership.

Run the focused tests on macOS or Linux with the repository's supported Node version:

```sh
node --test scripts/harness-lifecycle-fixtures/fixture.test.mjs
```

## Factory API

Import `createLifecycleFixture` from `factory.mjs`. It creates a fresh canonical private root under `parentDir` (the OS temporary directory by default), copies the executable adapter/helper and returns these controls:

| Member | Purpose |
|---|---|
| `root` | The new task-owned fixture directory; keep it outside model-writable workspaces. |
| `adapterPath` | The fixture executable for the existing runner's trusted adapter configuration. |
| `readOperations()` | Snapshots of independently published started, active and terminal markers, plus the actual effect-file presence. |
| `readAudit()` | `{ present, complete, events }`, with incomplete final records explicitly visible and malformed complete records rejected without their contents. |
| `readEvents()` | Complete-record phase snapshots while actors are running; final evidence also requires the audit completeness check. |
| `release(operationId)` | A one-shot gate allowing one fixed effect for that invocation. |
| `finish(operationId)` | Completes an invocation held after its effect. |

`holdAfterEffect: true` keeps the actual helper alive after it has committed the effect, until `finish` or cancellation. This provides a deterministic post-effect boundary for cancellation checks. The default completes immediately after the effect.

## Phase and effect contract

The executable accepts the `type-text` fixture action and ignores its payload. Other actions return the fixed `FIXTURE_UNSUPPORTED` result before starting a helper. Policy, approval, observation and model dispatch remain in the existing runner and shared execution pipeline.

Each invocation creates its own fresh operation directory. The child installs its cancellation handler, appends `helper-ready` and sends a readiness IPC message before the adapter publishes `active.json`. Consumers should correlate the recorded helper PID with the actual adapter child and observe the live phase before interrupting. The tests check the OS parent relationship independently.

Releasing the gate writes exactly one `effect.txt` containing fixed fixture text. Its exclusive create and one-shot gate prevent a repeated release from creating another effect. SIGTERM and SIGINT before release cancel the helper; after the helper is reaped, a late release produces no effect. Cancellation after commitment retains `effectCommitted: true` and preserves the effect file.

The adapter publishes its terminal marker only after the real child's close event. Consumers must still verify actual process absence rather than trusting `helperReaped` alone. A killed actor can leave incomplete state; retain that uncertainty and inspect independent process/effect evidence instead of inventing a terminal record.

## Privacy and cleanup

Fixture metadata contains fixed event names, operation identifiers, process identities, statuses and effect facts. Requested text and raw argv are never copied into metadata, stdout, stderr or the fixed effect. These fixture events are separate from the real connector's action audit; later harness qualification must check both.

A terminal audit-write failure still lets the child exit and be reaped. The adapter returns a fixed nonzero `FIXTURE_AUDIT_FAILED` outcome, retains the committed-effect fact and sets `auditWritten: false`. Unavailable or incomplete fixture audit remains an evidence failure even when cleanup succeeds.

Callers own the adapter process and its process group. Register it before inspecting readiness, terminate and reap only those owned actors, confirm their helpers are gone, and then remove only the fresh fixture root. Traversing or symlinked operation-directory gates are rejected. The focused tests keep all state under their own sandbox and verify the exact helper identity before any orphan cleanup.

## Acceptance boundary

These tests qualify the fixture's process and effect boundaries. Real-harness L3/L4 still requires the existing runner to exercise trusted approval, pending and active interruption, exit, session end, same-session Stop and cross-session isolation on pinned macOS/Linux harnesses. A fixture marker or a top-level passing receipt cannot substitute for those calls, complete host audit or independent cleanup evidence.
