# Harness Recipes and Startup Diagnostics Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks with test-first verification and one independent whole-branch review.

**Goal:** Deliver issue #34 as one reviewed, green PR: a print-only recipe command, sanitized startup reason codes and packed launch receipts for every recipe shape.

**Architecture:** Handle `recipe` before trusted startup, with a pure catalog/renderer in `src/mcp/recipes.ts`. Recipes contain a harness-native configuration snippet, an explicit connector startup template, version/source evidence, Node floor and qualification limits. Startup errors cross a fixed typed error boundary without exposing underlying exceptions. Existing policy, approvals, broker, audit and cancellation remain authoritative.

**Tech Stack:** TypeScript, Node >=22.14.0, existing compiled MCP stdio entry and official pinned MCP client, Node/tsx tests, existing package build and packed consumers.

**Spec:** User goal attachment b1b08234-4cca-4840-b79c-aa68f29c4ce5; GitHub issue #34 and task 3 of plan PR #38. The surrounding #32 acceptance ladder bounds claims, not this task's implementation scope.

## Global Constraints

- Work from main `155c30a1a0d0ee25ffaf94b45728eb1deebe59bc` on fresh branch `feat/harness-recipes-34` in the owned managed worktree.
- Preserve PR #30 and native-acceptance ownership. Do not edit release/version/build metadata or its connector tests; use separate recipe tests and a separate packed consumer.
- Never edit real harness configuration, profiles or credentials; use disposable homes. No local harness installation, paid provider, merge, publication, tag or privacy-setting changes.
- Keep MCP dependencies outside core and OpenClaw import graphs. No new runtime dependencies.
- All source prose paragraphs occupy one logical line. Preserve DCO and human attribution requirements.

## Review Focus

- Paths containing spaces, quotes, Unicode and control characters must serialize safely in JSON, TOML and YAML without becoming shell syntax or extra configuration.
- Recipe mode must not read the requested startup config, open audit/state/broker resources, or write any filesystem entry, including when paths are nonexistent or unwritable.
- Startup failures, including cleanup failures, must emit only allowlisted reason codes on stderr and no protocol stdout, private paths or exception text.
- Missing/version-unchecked harness support must be explicit; recipe and packed launch proof must not claim actual harness or native acceptance.
- Packed commands must use absolute Node and compiled entry paths, remain valid with a different cwd, and work without development dependencies or shell interpolation.

## Task 1: Verified catalog and print-only CLI

**Files:** Create `src/mcp/recipes.ts`, `src/mcp/recipes.test.ts`; modify `src/mcp/main.ts`; create evidence outside the repository.

**Interfaces:** `renderRecipe(args: string[], runtime: { node: string; entry: string }): string` returns a JSON recipe envelope with native snippet text and startup template. Supported ids: claude, codex, copilot, opencode, hermes, coven-code, grok, gemini, cursor, generic. Harness-specific entries are source-checked against pinned versions; Tier C remains unqualified. The command accepts explicit absolute config/workspace/state/adapter paths, defaults to clearly labeled absolute placeholders, and never writes them.

- [ ] Verify official source/config formats and pinned harness versions; retain immutable source links and distinguish installed --version/--help evidence from source-only checks.
- [ ] Add CLI tests that fail on absent recipe support: every id, native-format round trips, pathological paths, invalid flags, empty stdout on errors, and filesystem snapshots proving no reads/writes or startup.
- [ ] Run focused tests and preserve RED evidence; implement catalog, safe serialization and early CLI dispatch; run tests GREEN.
- [ ] Commit the tested recipe surface with DCO.

## Task 2: Fixed startup reason codes

**Files:** Create `src/mcp/startup-error.ts`, `src/mcp/startup-errors.test.ts`; modify `src/mcp/config.ts`, `src/mcp/main.ts`, and tighten existing config diagnostic assertions.

**Interfaces:** `StartupError` carries an allowlisted `StartupReason`; `startupDiagnostic(error: unknown): string` never renders arbitrary values. Classify arguments, config read/shape/ownership/mode, private state, audit destination, adapter path and inherited approval descriptor failures at their owning boundary.

- [ ] Add failing subprocess cases for each category, private canaries, invalid descriptor, existing unsafe destinations and no stdout/effects.
- [ ] Run RED; implement typed categories while preserving every existing admission check and missing-adapter deferred execution behavior; run focused startup and broker tests GREEN.
- [ ] Commit the tested diagnostic boundary with DCO.

## Task 3: Packed consumers, documentation and delivery

**Files:** Create `scripts/packed-recipe-consumer.mjs`; modify `scripts/test-packed-consumers.mjs` and `docs/mcp.md`; retain a requirement/evidence ledger and handoff outside the repository.

**Interfaces:** The packed recipe consumer uses the installed compiled entry to generate every recipe, extracts each native command/argument representation and launches it with the official client from a disposable cwd, then verifies handshake, single computer_use discovery and harmless health/Stop behavior. Tier C receives packed-shape proof only.

- [ ] Add a packed test that fails before recipe integration; wire the new consumer into test:packed without changing release metadata or PR #30 files.
- [ ] Document command syntax, preparation permissions, version/source evidence, fixed reason codes, actual model-visible naming evidence and unresolved harness/approval/native gates.
- [ ] Run pnpm run check and pnpm run test:packed; inspect exact tarball contents/hash and compiled import boundaries.
- [ ] Obtain independent whole-branch review; resolve important findings with failing regressions and full verification.
- [ ] Push a DCO branch and open one focused PR; await green exact-head CI and resolve actionable review conversations. Stop before merge/publication.
- [ ] Audit every issue/user acceptance row; hand off exact source/artifact identities, harness evidence, PR/check links, remaining limitations and rollback.
