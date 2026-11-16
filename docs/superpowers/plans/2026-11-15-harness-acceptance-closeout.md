# Harness Acceptance Closeout Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. The user authorized implementation through reviewable PR delivery; the ledger records acceptance and ownership gates throughout execution.

**Goal:** Complete the remaining approval and lifecycle qualification for issues 33 and 35, then deliver issue 37's evidence-backed harness support matrix.

**Architecture:** Reuse the existing real-harness runner, packed connector and separately launched approver. Extend qualification at the existing boundaries and derive documentation from versioned receipts, preserving native desktop acceptance as a separate gate.

**Tech Stack:** TypeScript, Node.js test runner, stdio MCP, deterministic local model endpoints, existing pinned harness binaries and Rust adapter fixtures.

**Spec:** User attachment `18c41bd2-ec20-468b-abe1-3732d05b7109/pasted-text-1.txt`; issue acceptance criteria for 33, 35 and 37.

## Global Constraints

- No merges, release publication, hosted Actions triggers, paid providers, uncertain-cost work, settings changes or messages to other people.
- Preserve existing worktree ownership; copying/integrating owned source requires an explicit handoff. Never read live harness credentials or modify operator configuration or desktop sessions.
- Keep approval authority out of model arguments and harness permission modes. Keep privacy, import and cancellation boundaries intact.
- Local full verification is `pnpm run check` and `pnpm run test:packed` on every final changed candidate. Missing capabilities are unqualified, never passing.
- Publish prose as one logical source line per paragraph. Retained public evidence must exclude private inputs, paths, credentials, image bodies and unrestricted logs.

## Review Focus

- Startup races must be distinguished from an actual approval decision and must not produce a passing qualification.
- Connector loss while approval is pending must yield no effect and bounded cleanup.
- Active interruption must check the actual task-owned process/effect boundary, including delayed work after terminal exit.
- Cross-session Stop must leave the other session intact, while same-session Stop cancels its own work.
- Support claims must preserve source identity, platform, version and known image-delivery failures rather than collapsing to a highest-level badge.

## Initial Acceptance and Ownership Ledger

Snapshot: main `3b57d45f60fbdd0d10dcf7baeccd24da2c114c0d`, tree `866b87c1f688b6caf7c256811c68c165637fb02a`, refreshed 2026-11-16 UTC.

| Requirement | Current evidence | Remaining work / owner |
|---|---|---|
| 33: reproduction and approval ADR | ADR accepted on issue 33; PR 42 `a5c6ea4`; existing Claude/Codex reproduction described by PR 49 | Verify retained receipts; preserve approval owner |
| 33: trusted approver and negative cases | PR 49 `f2721c6`; broker/PTY tests and macOS real-harness receipts | Exact combined-candidate verification; Copilot, Linux, real interruption and disconnected/busy cases remain unproven |
| 34: recipes and startup diagnostics | PR 43 `381feaa` | Reconcile pinned-source recipes with PR 51's observed launch shapes through owner |
| 41: schema compatibility | PR 50 `348bf14` | Preserve full boundary validation and verify packed combined candidate |
| 35: L1/L2 runner | PR 51 `20464d4`; macOS and hosted Linux receipts | Extend the existing runner only after explicit source handoff; no L3/L4 implementation is claimed yet |
| 35: L3/L4 across Tier A / two OSes | Missing | Allow, deny, expiry, cancel, UI loss, bypass modes, pending/active interrupt, exit/end, cleanup, audit and Stop isolation |
| 35: other harnesses and images | PR 51 records OpenCode/Hermes unqualified, Coven Code startup failure, Codex image loss and Copilot result spill | Preserve concrete blockers; do not promote missing levels to pass |
| 37: matrix and per-harness recipes | Local draft covers ten recipe IDs and twenty platform rows | Ownership confirmed; frozen recipe dependency integrated under explicit recipient permission; tests await CPU handback |
| 37: macOS permission attribution | No native harness attribution receipt | Document unverified status with OS/version; never change privacy settings |
| 37: repair hints | Main already has SDK/MCP-specific spawn hints | Verify actual SDK/MCP surfaces, permission guidance and package inclusion |
| Full final checks and reviewable delivery | Not yet run for this goal | Exact candidate check/packed results, scoped commits and PRs; pushing must not trigger Actions |

Concurrent integration task `01a1d88d-0ce2-70b2-a398-add47c703941` reports a broader harness goal including integration and issue 36. It confirmed this task owns issue 37's new guide and focused tests, with the README pointer after the recipe handoff. It confirmed L3/L4 editing remains gated on the issue 35 owner's explicit handoff. This task's narrower authorization does not inherit that task's merge or CI authority.

## Task 1: Verify prerequisites and obtain source handoffs

- [x] Inspect current issue comments, PR heads, changed paths and local ownership; record exact identities and acceptance gaps.
- [x] Establish explicit non-overlap with the integration task; frozen recipe read/copy integration is permitted.
- [ ] Obtain the qualification source handoff before editing its owned runner and verdict files.
- [x] Run baseline checks from the isolated current-main workspace; retain first failures and classify them before changes.
- [ ] Reconcile recipe discrepancies through the existing owner; do not make another recipe implementation.

## Task 2: Extend real-harness L3/L4 qualification

**Files:** Existing `scripts/qualify-harness.mjs`, `scripts/qualify-harness.test.mjs` and `scripts/harness-qualification/` modules, only after ownership handoff; sanitized receipts under `docs/harness-qualification/`.

**Interfaces:** Consume the existing packed connector, harness launch configuration, local model endpoint and verdict/privacy guard. Produce per-case sanitized receipts with exact harness/platform/candidate identity and explicit L3/L4 verdicts.

The existing `overall(levels, requested)` ignores run/lifecycle evidence. Add a runtime qualification gate in the owning verdict module after handoff: a timed-out or unexpectedly exited harness, leaked connector/helper, missing required audit completion, or audit privacy failure must prevent a pass even when the model saw successful observation results. Red tests must construct successful L1/L2 observations with each of those failures independently and require a non-passing receipt. Never repair this by deleting the evidence fields or changing expected outcomes to pass.

L3 cases must record the operator decision, observed tool outcome, final fixture effect, and audit completion independently. Cover allow, deny, cancel, expiry, UI disconnect, waiting/busy review and the harness's own bypass mode. The operator acts only through the existing foreground approver's PTY. A queue is not implicit authority: waiting work produces no effect until its own allowed decision; overflow fails closed.

L4 cases must synchronize on actual pending-review or active-helper entry before interrupting. Exercise harness SIGINT, exit/session-end, approver/UI loss, same-session Stop and a concurrent different-session Stop. Observe owned helper termination and the final fixture state after cleanup. A harness that serializes tool calls and cannot deliver same-session Stop during active work needs a concrete recorded blocker; an official-client-only Stop test cannot substitute for a real-harness receipt. Preserve the existing broker/core tests as separate evidence.

The support ladder stays cumulative. If Copilot's full health result still spills and L2 fails, passing individual L3/L4 cases cannot promote its overall support to L4. The independently owned discovery budget change remains a prerequisite for that support claim, with its own ADR approval and source ownership gates.

- [ ] Write failing verdict/receipt tests for every new L3/L4 requirement, including false pass, missing case and inconsistent-result rejection.
- [ ] Extend the existing runner and fixture to drive explicit approval decisions and pending/active lifecycle events; preserve source/packed separation and bounded process cleanup.
- [ ] Run targeted tests, then real pinned Claude Code, Codex and Copilot binaries using only disposable homes and local model endpoints.
- [ ] Run the corresponding Linux matrix in an existing local disposable environment if available; record exact missing resources as blockers without hosted Actions or local CLI installation.
- [ ] Commit scoped qualification changes after focused and full checks; preserve first failures and all unresolved gaps.

## Task 3: Deliver support documentation and its consistency checks

**Files:** New `docs/harnesses.md`, a focused `src/harness-documentation.test.ts`, a focused `src/standalone-repair-hints.test.ts`, and the README pointer; product guidance changes only if verification demonstrates a real defect and ownership permits them.

**Interfaces:** Read recipe output for harness IDs, pinned evidence and configuration shapes; read sanitized runner receipts for support cells. Produce documentation whose claims are bounded by those sources and tests that fail when harness IDs, evidence or packed documentation drift.

- [x] Write the matrix/recipe consistency test first, checking missing, duplicate and unsupported IDs and evidence/unverified markers.
- [x] Add per-harness versioned support cells and recipes, explicitly separating L0, real harness fixture qualification and L5 native acceptance.
- [x] Add per-launcher macOS Screen Recording/Accessibility guidance with verified/unverified attribution and OS version; do not infer grant ownership from inventory.
- [ ] Verify SDK/MCP repair hints through their public surfaces and confirm the packed tarball includes the new guide and working references.
- [ ] Run `pnpm run check` and `pnpm run test:packed`, inspect exact candidate diffs and sanitized receipts, then create/update focused PRs without triggering hosted Actions.

## Completion Gate

Audit every acceptance row against authoritative current files, receipts and terminal results. Leave unmet platform, owner or approval gates open with concrete next actions. Do not mark this goal achieved merely because documentation records an incomplete gate.

## Execution Record

- Initial refresh and isolated worktree created; no existing branch changed, no harness or desktop action run, and no hosted workflow triggered.
- Offline frozen dependency installation reused 431 packages and downloaded zero. Baseline `pnpm run check` exited 0 on main `3b57d45` before product edits; Rust reported 112 unit tests and one CLI cancellation integration passing, with the pre-existing fixture dispatcher ignored.
- Added twelve public SDK / modern MCP / legacy MCP repair-advice tests for missing/nonexecutable adapters and explicit macOS denial/grant fixtures. All twelve pass without a product change. `pnpm run typecheck` exits 0.
- New guide consistency tests first failed because the guide was absent. After adding the guide, both-platform evidence coverage and actual tarball body inclusion pass; the recipe sync test still fails because current main lacks the recipe help/dispatch. No skip or weaker predicate was substituted for that dependency.
- The guide's sixteen receipt links were audited against the retained receipt JSON: L1/L2 verdicts, harness versions, platform, image handling and connector tarball hashes match. Missing commit identities remain explicit.
- The recipe owner recorded a read/copy handoff specifically to the integration task. That recipient explicitly authorized this task to incorporate frozen `381feaa` only as a dependency and keep issue 37 commits separate. Dependency merge commit is `56d78760f16336d6a42c213d84c626cff0a6a08d`, tree `490da28bf2710bc2791db272ed7959f0e5443023`; its eleven paths merged cleanly. No original recipe branch/worktree changed, no recipe runtime edit was made, and combined qualification remains pending. Other PR ownership was explicitly excluded from that handoff.
- Native acceptance owner requested a bounded macOS CPU window. All this task's existing process handles were verified terminal, and full/packed/harness tests are deferred during that window; file-only work continues.
- Ruling: execute the user-specified milestone plan inline without another approval checkpoint, because the active goal explicitly authorizes scoped implementation through reviewable delivery. Source ownership and side-effect restrictions still gate their dependent steps.
- A fresh source-only review confirmed the sixteen receipt facts but found two P2 test gaps: URL presence did not reject contradictory claims, and CLI help duplicated the renderer's private recipe list. Seven negative matrix cases are prepared for RED execution after native CPU handback. The validator fix is deliberately pending that RED run. A narrow shared registry export/help follow-up was requested from the recipe integration owner; no recipe runtime change was made here.
- Review also found nested adapter-spawn guidance omitted from the new public-surface negative assertions and imprecise startup wording. Those scoped coverage/copy corrections are made but not rerun yet. Direct-connector and attach/approver launcher chains are now distinguished in the unverified permission table.
- Ruling: address the two minor review items within this task because they concern the explicitly required repair-hint coverage and permission guidance, rather than unrelated refinement. The remaining risk is unverified current test code until the held runtime gates resume.
- Native owner gave actual terminal/cleanup handback. No native action was performed by this task. The seven contradictory-claim cases were observed RED against the URL-only validator, then GREEN with an independently transcribed immutable receipt oracle. A second review found header relabeling could present L2 as L5; two additional RED cases now pass with exact ordered-header validation.
- Ruling: read the authoritative renderer's literal registration metadata through the existing development TypeScript parser rather than requiring an optional runtime export from its owner. This keeps the frozen dependency unchanged while detecting a new registered recipe omitted from both help and docs. A future renderer representation refactor must update this fail-closed test reader or supply a shared registry interface.
- The focused suite passed all 25 cases and typechecking exited 0. A final source-only rereview found no remaining P1/P2 issues; it did not independently rerun those commands.
- First full candidate check exited 1 on the existing tool-name spelling guard: three literal names in this task's two new test files violated the shared-constant policy. The first failure log is retained privately. The new files now use `COMPUTER_USE_TOOL_NAME`; the existing guard is unchanged. Focused guard/full verification is repeated after this concrete fix rather than retrying an unchanged candidate.
- The integration coordinator confirmed the README is owned by PR 49 and must remain untouched until its owner handoff. The required README pointer, issue 35 source edits, and combined approval/schema verification remain open gates. The source support guide cannot close issues 33, 35 or 37 by itself.
- The second full run exposed a task-local environment mistake: `umask 077`, used for log privacy, masked two existing audit-public fixtures from requested `0644` to actual `0600`. The connector correctly accepted the private fixture and waited for input. After confirming the exact fixture mode and owned connector identity, this task requested its normal SIGTERM cleanup; the run terminated with both audit-public assertions failing. No existing test or production guard changed. Subsequent runs use normal `022` permissions and separately precreated `0600` logs.
