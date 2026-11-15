# Wayland OpenClaw provider qualification plan

> **For agentic workers:** Execute inline with superpowers:executing-plans and a fresh source review before delivery. The original native acceptance goal already authorizes this continuation.

**Goal:** Prove actual controlled Wayland pixels reach an unchanged official OpenClaw provider, followed by actual trusted approval, directly observed focused-entry input, and denial without an effect.

**Architecture:** Keep the existing PR44 native driver and receipts frozen. Add a separately owned Wayland consumer using the reviewed PR40 compositor/fixture collector only after an explicit source-bound read/copy handoff. Reuse the frozen matching production pair. Until that handoff, implement only the pure fixture-effect checks; these do not establish native or provider acceptance.

**Tech stack:** Node built-ins, packed OpenClaw plugin and official host, actual Sway/GTK/grim/wtype inside one exclusively leased software Wayland namespace.

**Spec:** The active original #21 native acceptance objective; the source-bound public acceptance checkpoint in issue comment 6886660549; root/PR40 owner lane handoff on 15 November 2026.

## Global constraints

Preserve all original #21 criteria, the strict failed queued-UI gate and macOS/physical requirements. No hosted-provider calls, helper installation, privacy changes, user-session input, daemon/device/capability escalation or release/publication. Default preflight is read-only; graphical execution needs explicit current fixture/helper/namespace identities and a bounded exclusive lease. Missing capture/input support stays unqualified or visibly unsupported. Do not copy PR40's dirty collector. The provider lane owns only `scripts/native-wayland-openclaw/**` and this plan.

## Review focus

An allowed action must produce exactly the planned fixture text/hash/key transition, while capture-only, forged confirmation plus denial, and rejection preserve every control. Counter changes, unexpected clicks/scroll, lost entry focus, changed fixture identity and malformed observations must fail. Receipt output must contain no raw text, image bytes, private paths or model-supplied approval. These pure checks establish reported fixture transitions only; the eventual driver must independently bind live fixture identity, capture scope, actual provider transport and real host approval.

### Task 1: Pure fixture effect proof

**Files:** `scripts/native-wayland-openclaw/effect-proof.mjs`, `effect-proof.test.mjs`.

**Interface:** `proveTextEffect({before, after, text, decision})` consumes identity-bound control summaries with `fixtureIdentity`, `entryFocused`, `textLength`, `textSha256`, `keyCount`, `clickCount` and `scrollOffset`. Only empty initial text plus one bounded lowercase ASCII marker is supported for the first positive/denial workflow. `decision` is trusted harness state `allow`, `deny` or `capture-only`; it is never obtained from tool arguments. The result contains only validated counts, hashes and decision class, and never claims live identity or provider/native provenance.

- [x] Run an existing local baseline check, then write expected positive and adversarial tests before implementation: exact one effect; wrong length/hash/key count; unrelated click/scroll; stale identity; lost focus; malformed counts/hash/decision; denial and capture-only no effect; marker absence from receipt.
- [x] Observe expected RED, implement the minimal proof, then run all focused tests to GREEN. Keep first failures and command results.
- [x] Review the isolated source. Preparation remains unqualified for native input.

### Task 2: Actual provider capture and trusted effect

**Dependency:** Wait for the PR40 owner's reviewed source-bound Wayland collector handoff before defining its integration interface or executing it. No timer or owner silence supplies that handoff.

- [ ] Bind native/package/helper/compositor/fixture identities, outputs and scale; use actual received image bytes and independent compositor mapping to prove the controlled screen and text-entry target. A keyboard effect does not qualify unavailable pointer input.
- [ ] Use a separately staged official OpenClaw host and actual approval RPC for one planned text effect, then a distinct fresh empty fixture for forged confirmation plus denial, with no repeat of the failed Stop/UI experiment.
- [ ] Inspect before/after fixture summaries and controlled images, enforce helper/process cleanup and audit payload absence, and retain a sanitized source-bound receipt. Run required repository/packed checks and exact-head hosted checks before any source delivery. Keep all omissions and wider acceptance gates explicit.

## Execution choice

Continue inline under the already active original goal and existing runtime coordination protocol. Native execution is not authorized by a passing pure test; it still needs the source handoff and actual exclusive runtime lease. The current pending PR44 ready transition and its frozen candidate are separate.

Task 1 preparation: existing raw-callback baseline passed 3 tests; the no-op proof scaffold produced 50 expected failures, followed by 50 passing behavior tests. A further regression demonstrated that equality assertions could echo an unvalidated focus value; a boolean guard fixed that leak and all 51 tests pass. Fresh FILEONLY review found no Critical, Important or Minor findings, and did not independently execute tests. Required full repository check (364 TypeScript tests, 26 gateway fixtures, seven import graphs, 112 macOS Rust unit tests and one CLI cancellation integration; one preexisting ignored Rust fixture) and packed consumers passed with terminal exit 0; no native/provider result follows from this pure preparation.
