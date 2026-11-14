# X11 cancellation input-state plan

> For agentic workers: use superpowers:executing-plans inline, then a fresh final source reviewer.

**Goal:** Fix the reproduced stuck X11 key after cancelled typing, preserve unrelated/preheld state and make cleanup confidence visible through CLI, SDK and MCP.

**Architecture:** A private bounded child keeps one X connection and a qualified helper map. It compensates only the imminent input and helper-cleared preheld state after the input helper is reaped. Unknown environments retain existing helper execution with explicit unverified cleanup.

**Tech stack:** Rust 1.88, existing libc/dlopen, system libxdo/X11/XTest, existing TypeScript runner and safe result projection. No new platform service or automatic install.

**Spec:** `docs/superpowers/specs/2026-11-14-x11-cancel-input-design.md`, including its builder-check decisions and binding user goal.

## Global constraints

- Fresh main branch, explicit X11 path lease, no edits to the Mac owner or PR30 worktrees/artifacts.
- Use only the exclusive owned X11 lease; always recover the exact server, introduced keys and owned helpers.
- No global key-up sweep, cancelled input replay, deadline extension, weakened checks or private data in diagnostics.
- A qualified cleanup report is scoped to owned intended state; unknown/concurrent external state is never guessed into a verified pass.

## Review focus

- A new unrelated or future-request key must not be released; preheld state must be restored only within helper scope.
- Unicode scratch mapping, modifier selection and keyboard group must follow the actual qualified helper.
- Probe/cleanup blocking and parent termination must leave no guard/helper process running beyond bounds.
- Cleanup fields crossing process failure/redaction must reject arbitrary strings, raw state and invalid counts.
- CLI cancellation, SDK Stop/Abort and MCP Stop must retain the actual first failure and prove no newly generated late events.

### Task 1: Scoped state planner and guardian lifecycle

Files: new `src/x11_input/{mod.rs,state.rs,guard.rs,xlib.rs}` and native regression script under `scripts/native-x11-stop/`.

- [x] Write failing pure planner cases for current intended release, unrelated/future keys, preheld restoration, cleared modifiers/buttons, lock/group/scratch limits.
- [x] Implement the pure planner and qualification inputs from the fixed helper ABI.
- [x] Add real owned pipe/fork timeout, parent EOF and cleanup reaping regressions; implement independent bounded supervision without a production command bypass.

### Task 2: X11 dispatch and sanitized consumer projection

Files: scoped X11 sections of `src/main.rs`, process observation helper only if needed, and explicitly handed runner/core sanitizer paths plus privacy regressions.

- [x] Integrate qualified imminent-character dispatch with bounded logical summaries and unchanged action deadline; unqualified helpers keep the original route.
- [x] Add strict cleanup enum/count validation to process cancellation projection and typed-result redaction; preserve cancellation/timeout precedence and unknown-progress facts.
- [x] Reproduce invalid/secret-bearing cleanup metadata and missing native evidence before adding the safe projection.

### Task 3: Real acceptance and reviewed delivery

- [x] Rebuild an isolated exact-source Linux candidate in the leased container; do not overwrite the frozen baseline.
- [x] Repeat the deterministic held-key interruption and preheld/unrelated/Unicode/modifier cases against actual helper state, with unconditional recovery.
- [x] Install a matching packed consumer and rerun actual SDK/MCP cancellation cases. Preserve queued pre-return events separately from new post-return generation.
- [ ] Run full default `pnpm run check`, relevant packed/native checks and fresh source review. Deliver a scoped green PR and merge only within the authorized path.
- [ ] Return the lease with final source/package/native/helper identities, receipts and live handles; keep full #21 acceptance gates open until independently proven.
