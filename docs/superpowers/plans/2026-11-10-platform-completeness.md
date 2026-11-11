# Platform completeness implementation plan

> Execute inline with the executing-plans and test-driven-development guidance. User authorization covers implementation, commits, task branch pushes, and PRs; never merge or release.

**Goal:** Fulfil the five improvements in the attached Goal 2 specification, retaining real graphical acceptance gates.

**Architecture:** Keep platform actions in the Rust adapter and scoped host operations in the TypeScript plugin. Share bounded child execution within each language, with honest structured errors and no raw failing-command diagnostics. Preserve existing approval gates.

**Spec:** User attachment `257926fc-b8fd-407a-b12c-0fd48b53b662/pasted-text-1.txt`; requirements and baseline matrix in `docs/platform-evidence.md`.

**Constraints:** Start at current origin/main, preserve old branches/worktrees, no system helpers/privacy changes, no merge/release, Windows desktop unsupported, use REST, one logical line per prose paragraph.

**Review focus:** children ignoring TERM or inheriting pipes; partial sequences; leading-dash or compositor command injection; symlink paths with nonexistent write parents; diagnostics and audit fields echoing private values.

### Task 1: Bound helpers and report truthful results

- [x] Add real helper-process regression tests for success, missing helper, permission denial, malformed JSON, bounded timeout, descendant cleanup, safe argv, and stop-after-failure sequences; observe failures.
- [x] Add Rust helper runner with a cumulative 30-second default action deadline (CLI override 1000–120000 ms), output limit, process group cleanup and cancellation. Validate Peekaboo envelopes and Sway replies. Expose timeout/cancellation/partial progress in results without raw private diagnostics.
- [x] Add TypeScript child runner, per-tool abort controllers, session-scoped stop across tool instances, gateway AbortSignal support, one shared deadline across observation retry, and sanitized failures. Validate timeout input.
- [ ] Run focused tests and `pnpm run check`.

### Task 2: Verify file and durable audit boundaries

- [x] Add regression tests for relative traversal, directory/file symlinks including nonexistent write targets, denied file-read contents, diagnostics containing arbitrary text and secret-bearing URLs/argv, and failing audit writes; observe failures.
- [x] Resolve real paths (nearest existing ancestor for writes), reclassify the canonical target, preserve approval for deliberate external paths, prevent implicit content previews, summarize audit strings and fail visibly on audit errors.
- [ ] Run focused tests and `pnpm run check`; commit a focused runtime-safety PR with full validation and CI workflow.

### Task 3: Linux capabilities and host integrations

- [ ] Add deterministic tests for compositor/tool combinations, wtype/ydotool selection, scrolling, screenshot degradation/failure, focus injection and replies, clipboard/launch tools with argv/stdin; observe failures.
- [ ] Make doctor report available/degraded/unsupported/unverified per capability; probe Wayland advertised protocols when wayland-info exists, otherwise avoid assuming wtype/grim support. Support ydotool typing/key fallbacks and Sway-only focus. Keep action errors honest and stop sequences at failure.
- [ ] Add bounded Linux clipboard via wl-copy/wl-paste or xclip/xsel, browser via xdg-open, app via gtk-launch desktop id. Keep existing approval policy and explicit unsupported responses.
- [ ] Update matrix, bounds/stop/privacy documentation, and exact-head handoff. Run `pnpm run check`; commit/push focused dependent platform PR, verify hosted CI for both PRs, record unavailable graphical acceptance gates. Do not merge.

## Execution ledger

- Baseline check passed (20 TS, 14 Rust); no open inventory items or reliability PR to disposition. Fresh task worktree `/tmp/desktopuse-platform-completeness`.
- Design choice: bounded local helper execution retains the adapter architecture; replacing helpers with compositor/OS libraries would expand runtime ownership. Acknowledge injected runners only cancel cooperatively; file system operations already in progress cannot be rolled back by stop. Existing user task authorization takes precedence over extra skill approval rounds.

- Runtime/privacy tests: 33 TypeScript and 24 Rust passed (one ignored Rust test is only the subprocess fixture entry, explicitly invoked by four parent tests). Baseline failures reproduced and corrected; static /tmp-to-/private/tmp workspace alias handling also covered.
