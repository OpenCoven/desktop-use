# Reliability Delivery Implementation Plan

**Goal:** Deliver the five reliability requirements in the user-approved attachment as a reviewable PR with green macOS/Linux CI.

**Architecture:** Keep the existing TypeScript tool and Rust adapter boundary. Validate inputs from the tool schema, retain process and action outcomes separately, and expose safe structured execution and audit errors.

**Execution:** Inline implementation is authorized by the active goal. Use regression-first changes, then review the final branch before publishing. Preserve existing branches and worktrees.

- [x] Add failing regressions for invalid types/actions/enums/numeric bounds/UTF-8 bytes/NUL argv and approval-hook validation. Implement validation before classification and execution.
- [x] Add a real adapter fixture process covering success, error, unsupported, confirmation, and malformed output; cover bounded observation retry and no interactive retries. Preserve the JSON action outcome independently of process exit.
- [x] Add failing regressions for filesystem/adapter execution exceptions and actual audit failure. Return safe structured errors and redact durable request/result summaries.
- [x] Add macOS/Linux CI for `pnpm run check`; make Rust confirmation tests independent of the host display session. Update operator documentation.
- [ ] Run `pnpm run check`, inspect the final diff, create signed-off commits with verified noreply identity, push the task branch, open a PR, and inspect every hosted result. Do not merge or release.

**Review focus:** malformed argv must never execute; UTF-8 bounds must count bytes; process success must not hide action failure; audit errors must not replay actions; retries must not repeat input or permission denials.

**Initial inventory:** origin/main is `8db9aa1fa2b70c38d8b48fad46f9c896805c2b87`. GitHub REST reports no open issues or PRs; remote branches are main, docs/agents-claude-guidance, and feat/linux-x11-wayland-support. The missing fix/tool-reliability worktree has no recoverable commits in its branch/reflog. Rebuild on fix/reliability-delivery in this persistent sibling worktree.

**Independent review:** Two important findings were reproduced with failing tests and fixed: joined key argv could exceed the byte cap; exit-zero backend diagnostics could expose typed input. Actual process timeout retry was also reproduced and fixed with structured ETIMEDOUT handling. No deferred review findings remain.

**Local validation:** `pnpm run check` passes with 56 TypeScript tests, 14 Rust tests, typecheck, and the plugin-runtime import guard. `git diff --check` passes. Hosted CI remains the final delivery gate.
