# Harness Lifecycle Fixture Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. The active goal authorizes harness acceptance work; the coordinator explicitly handed off this new namespace while existing runner integration remains held.

**Goal:** Provide a deterministic active adapter/helper fixture with independently observable phase, effect and cleanup evidence for later real-harness L4 qualification.

**Architecture:** A Node-only factory creates a fresh private fixture root and executable adapter/helper copies. Each invocation has its own operation directory. A real child announces readiness before the adapter exposes an active marker; an external one-shot gate permits one fixed filesystem effect. Cancellation waits for the child to be reaped before reporting terminal state. Metadata contains fixed event names, process identities and effect/phase facts, without requested text or argv.

**Tech Stack:** Node.js built-ins, CommonJS fixture executables, ESM factory and Node test runner.

**Spec:** Active user goal for issues 33/35/37 and coordinator handoff to `scripts/harness-lifecycle-fixtures/`. The source-owned `scripts/harness-qualification/` directory and existing runner remain unchanged.

## Global Constraints

- Keep all changes in this new namespace. Preserve the committed issue 37 donor and every existing source branch.
- No native desktop effects, model/provider calls, live credentials, hosted Actions, user configuration changes or current harness-support claims.
- One fixture invocation must not release or cancel another. Pending approval must be able to leave this fixture entirely unstarted.
- Use actual child entry, effect boundary and external PID absence checks. A self-reported terminal flag alone is insufficient cleanup proof.
- Preserve privacy: events, state, stdout and stderr never retain requested text, clipboard contents or argv.
- Full final checks remain `pnpm run check` and sequential `pnpm run test:packed`; focused fixture tests run explicitly until the existing runner's owner wires them into its own suite.

## Design Calls

The existing runner embeds an observation-only fixture; editing it requires its owner's handoff. A separate active-helper fixture in the granted namespace supplies the missing process boundary without introducing a second harness runner. Multiple invocation directories are needed for future same-approver cross-session cases. The factory and control gate are trusted test infrastructure; they confer no desktop approval authority.

## Review Focus

- A readiness marker must follow a real child readiness handshake, rather than merely successful process creation.
- Releasing a gate after cancellation must produce no delayed effect from a remaining helper.
- Cancellation after an already committed effect must preserve that fact rather than imply rollback.
- Concurrent operations must retain distinct gates, markers and process identities.
- Requested private input must be absent from every retained fixture channel.

## Task 1: Active helper, isolated operation state and one effect

**Files:** `factory.mjs`, `adapter.cjs`, `helper.cjs`, `fixture.test.mjs` in this namespace.

**Interfaces:** `createLifecycleFixture({ parentDir?, holdAfterEffect? })` returns `root`, `adapterPath`, `readOperations()`, `readAudit()`, `readEvents()`, `release(operationId)` and `finish(operationId)`. Operation snapshots contain independently written active and terminal metadata; tests observe real child PIDs separately. Audit snapshots expose presence and completeness explicitly; event-only snapshots serve phase observation. The optional post-effect hold creates a deterministic cancellation boundary after commitment without timing guesses.

- [x] Write a test that launches the real adapter, waits for an active marker and confirms its child PID is live while no effect exists.
- [x] Observe the missing fixture contract fail, then implement private root creation, executable copies, unique operations and readiness IPC.
- [x] Add a one-shot release test proving exactly one fixed effect, one matching event and no remaining helper after completion.
- [x] Reject unknown actions and invalid/traversing operation IDs before an effect or foreign-file write.

## Task 2: Cancellation, isolation and private metadata

- [x] Add real SIGTERM/SIGINT and concurrent-operation tests; observe the two post-effect hold cases fail before implementing that boundary.
- [x] Handle cancellation in the actual adapter/helper process tree and wait for child close before terminal reporting.
- [x] After cancellation, prove the helper PID is absent, release the old gate and confirm no late effect.
- [x] Pass a private input canary and check all fixture files and output channels for absence of the canary and raw argv.
- [x] Ensure test teardown terminates only its exact spawned process group, awaits its own child and then removes only its own fresh fixture root.

## Task 3: Verify and hand off

- [x] Run focused Node fixture tests and inspect actual state/effect boundaries.
- [ ] Run full repository and sequential packed-consumer checks on the final source tree; preserve first failures and environment identity.
- [ ] Obtain fresh source review, commit this concern separately and hand off exact source/API/test results for later existing-runner integration.

## Acceptance Limits

Fixture success establishes the controlled process boundary only. Real harness approval, interrupts, same-session Stop, cross-session isolation and the full macOS/Linux L3/L4 matrix still require actual calls through the owned runner after its explicit integration handoff. No support level or issue is completed by these fixture tests alone.

## Execution Record

- The initial two cases failed on the absent factory, then passed with actual adapter/helper processes. The post-effect hold's two cases next failed because the helper completed too soon; the explicit fence and finish gate made them pass.
- Audit completeness first failed on the missing snapshot API, then passed with explicit missing/truncated status and fixed diagnostics for malformed records.
- Twelve focused cases pass, including an independent OS parent-PID check, direct SIGTERM/SIGINT and process-group cancellation, post-effect cancellation truth, two isolated operations, private-input exclusion, unsafe gate rejection and terminal audit-failure cleanup.
- Base refreshed by fast-forward to current main `42d09f1ede9f51bc0a9e0b623dc9d4fddfd501d1`, tree `490da28bf2710bc2791db272ed7959f0e5443023`, after the recipe integration landed. No PR 51 source or issue 37 donor file changed.
- Ruling: the trusted test fixture uses Node built-ins and private filesystem/IPC controls rather than another harness/model runner. The original goal and the coordinator's explicit additive namespace handoff authorize this implementation; subsequent wiring still requires the existing runner owner's handoff.
- A fresh source review found that a failed terminal audit append could leave the helper's IPC connection live after its done flag was set. The actual post-effect fault probe reproduced a cleanup timeout; the exact old source and RED log were retained privately. Helper exit now survives logging failure, and adapter audit failure stays sticky without skipping child cleanup. The committed effect is preserved, the helper is externally observed absent, and diagnostics stay fixed. The regression completes in about 100 ms after the fix.
- Fresh-context shared-account rereview found no remaining material P1/P2 issue and independently reran all twelve focused tests successfully. This provides no external or human acceptance and no real-harness qualification.

## Integration review and qualification

The integration owner copied the frozen donor into a separate branch. The donor's no-hosted-Actions constraint applies to its original preparation; the activated integration goal expressly authorizes no-secret hosted qualification and normal PR delivery. A new focused workflow runs the Node-only fixture tests on Ubuntu 24.04 and macOS 15 with read-only contents access and exact PR-head checkout.

Fresh integration review found two Important defects: direct helper cancellation after an effect could be reported as success, and startup/readiness state failures could leak private filesystem diagnostics or strand a helper. Four fault regressions failed on the retained donor. A fifth regression proved that a stopped helper could exceed the cancellation bound. The single review fix pass distinguishes helper cancellation from normal completion, sanitizes state failures and reaps only the owned child with bounded TERM-to-KILL escalation. All seventeen focused tests pass after the fixes. Full integration checks and sequential packed checks are recorded separately in the PR and acceptance ledger; these results do not establish real-harness L3/L4.
