# Harness computer use implementation plan

> **For agentic workers:** This is a long-running goal. Work it issue by issue through the iteration protocol below: one focused PR per issue from fresh `origin/main` in its own worktree, with independent review before delivery.

**Goal:** Make `computer_use` (the `coven-desktop-use` adapter behind the shared `DesktopClient` pipeline) usable from every OpenCoven harness, at a support level proven per harness by evidence. "Supported" means a real harness binary discovers the tool, gets correct observation results, and completes a gated effect only after trusted human approval, with nothing weakened in policy, approval, audit or cancellation. Keep going until every in-scope harness reaches its target level or has a concrete recorded blocker, then keep pinned versions green and report drift against newer harness releases.

**Architecture:** Every harness reaches the adapter through the local stdio MCP connector (`coven-desktop-use-mcp`) and the shared execution pipeline. OpenClaw keeps using the plugin. The adapter supplies the contract, a trusted reference approval path, print-only recipes and conformance receipts. Harnesses keep their own auth, models and tool UX. Coven attaches the connector through each harness's native MCP configuration, not through new harness adapters.

**Tech stack:** TypeScript, tsx/node tests, the pinned official MCP SDK, the packed candidate tarball, real harness binaries under disposable config homes, deterministic local model endpoints, the existing Rust CLI and checks.

**Spec:** Tracking issue #32 with sub-issues #33 (approval routing), #34 (launch and recipes), #35 (real-harness conformance), #36 (CI lanes and drift) and #37 (docs and permission guidance). Related: #21, #24, #25 and PR #30.

## Baseline (verified 2026-11-14, main `155c30a`)

- Existing surfaces: the Rust adapter (macOS via Peekaboo, Linux X11/Wayland helpers, Windows explicitly unsupported); the OpenClaw plugin (`computer_use` plus legacy `desktop_use`), gateway-qualified on 2026.4.26 and 2026.11.3; the host-neutral SDK `DesktopClient`; and the local stdio MCP connector plus a terminal reference approval host. Both MCP wire revisions (2026-07-28, 2025-11-25) are verified, but only against the official MCP SDK client.
- No real coding harness has been shown to launch the connector, list `computer_use`, call it, or route an approval.
- SDK and MCP exports are unpublished: npm `0.1.3` does not contain them. PR #30 (paired release pipeline) is open.
- Approval blocker, inferred from source and reproduced first in #33: the reference approval host opens `/dev/tty` (`examples/approval-host/terminal.ts`). When a TUI harness launches the MCP server, that is either the harness's own terminal (prompts collide) or absent (every gated action fails closed). Without a broker, gated operations return `needsApproval` with no effect.
- Coven already discovers harness-native MCP configs for codex, claude, copilot, opencode, coven-code, cursor and gemini (`crates/coven-cli/src/capabilities.rs` in OpenCoven/coven), and its Claude stream launch accepts `writeScope.mcpConfigFile` plus `mcpServerNames`.

## Support ladder

Each level requires all the levels below it.

| Level | Meaning | Proof |
|---|---|---|
| L0 Recipe | Config documented and checked against the harness's current docs or `--help` at a pinned version | Recipe, version and date |
| L1 Discovery | A real harness binary starts the connector and lists exactly one desktop tool, `computer_use` | Receipt from a disposable config home |
| L2 Observation | A harness-issued `health` or `screenshot` call round-trips; structured content is preserved; image content is accepted, or its loss is documented | Receipt, fixture adapter |
| L3 Gated effect | A gated fixture effect (workspace `file-write`) reaches the trusted approval provider. Allow gives exactly one effect; deny, expiry and cancel give none; harness auto-approve modes do not authorize it | Receipt and audit lines |
| L4 Lifecycle | Harness interrupt, exit and session end abort pending and active work, reap helpers and write audit. Same-scope Stop works; cross-scope Stop cannot | Receipt |
| L5 Native | A real graphical action through the harness on a host with existing helpers and grants | Separate evidence class, never inferred from fixtures |

## Harness scope and targets

| Tier | Harness | Path | Target |
|---|---|---|---|
| A | OpenClaw | Plugin (existing) | Keep current gateway qualification green; no regression |
| A | Claude Code | MCP stdio | L4 |
| A | Codex CLI | MCP stdio | L4 |
| A | GitHub Copilot CLI | MCP stdio | L4 |
| B | OpenCode, Hermes, Coven Code | MCP stdio | L2, plus L3 and L4 where the harness permits |
| C | Grok Build, Gemini CLI, Cursor, generic MCP client | MCP stdio | L0 only, labeled unqualified |

Tier C makes no support claim, consistent with Coven's rule against speculative harness adapters. A harness is promoted only on evidence. Windows remains unsupported in every harness and must return the clean unsupported result through each path.

## Global constraints

- AGENTS.md: thin adapter; plugin-runtime import boundary intact (MCP dependencies never enter the OpenClaw or core import graph); never push to `main`; one concern per PR; conventional commits; DCO sign-off; numeric-id noreply `Co-authored-by` trailers for human contributors.
- Trust boundary unchanged: every harness goes through the shared policy, approval, audit and cancellation pipeline. No harness-specific bypasses and no new authority derived from MCP client metadata.
- Never touch the operator's real harness configs, profiles, credentials or OpenClaw state. Use disposable homes.
- Ask before installing desktop helpers, changing privacy grants, installing or upgrading harness CLIs on the operator's machine, or using a paid model provider. CI may install pinned harness versions.
- No merge, release, npm publish or branch-protection change. Stop at green, reviewed PRs.
- Keep evidence classes separate: fixture, packed, hosted CI, real harness and native desktop. Never relabel a failure as proof; keep the red logs.
- Keep prose paragraphs on one source line, and put no credentials, captured prompts, private paths or unrestricted logs in issues, PRs or retained evidence.

## Review focus

- Harness tool-permission prompts and auto-approve flags (for example `--dangerously-skip-permissions`, `--yolo`, `--allow-all-tools`, full-auto modes) must never satisfy desktop approval.
- An approval surface must not be answerable by the model or by the harness process on the model's behalf.
- A missing binary, endpoint or capability must surface as `unqualified` with a reason, never as a pass or a silent skip.
- Harness differences must be recorded rather than smoothed over: tool-name prefixing, dropped or transformed image and structured content, interrupt-to-cancel mapping, and child-process lifetime.

## Task 1: Inventory and reproduce (#32, #33)

- [ ] Fetch main and take a REST inventory of open issues and PRs, respecting GitHub rate limits. Decide how this work relates to PR #30.
- [ ] Record installed harness versions without installing or upgrading anything.
- [ ] Reproduce the reference approval host's behavior under Claude Code with a disposable config home and the fixture adapter, and keep the receipt.
- [ ] Seed the harness × level matrix in the evidence directory with every cell unverified.

## Task 2: Approval routing (#33)

- [ ] Write the ADR, evaluating a separately launched approval host on the existing broker socket, MCP elicitation, an OS-native prompt, and a Coven/Cave/OpenSide panel, each with a trust analysis.
- [ ] Stop for owner sign-off on the ADR before implementing.
- [ ] Implement the chosen surface, preserving the broker's challenge binding, nonce/HMAC, expiry, replay register and display limits.
- [ ] Prove allow, deny, expiry, cancel, disconnect, busy prompt and auto-approve behavior under each Tier A harness.

## Task 3: Harness-launchable connector and recipes (#34)

- [ ] Verify the compiled connector starts from each Tier A and Tier B harness's stdio launch context.
- [ ] Add the print-only recipe command, using `coven-desktop-use` as the server key, and record each harness's model-visible tool name.
- [ ] Add fixed startup-failure reason codes that reveal no paths or contents.
- [ ] Extend packed-consumer tests to launch the connector with each recipe's shape.

## Task 4: Real-harness conformance (#35)

- [ ] Add `scripts/qualify-harness.mjs --harness <id>` with disposable homes, the packed connector, the fixture adapter, scripted approval decisions and a deterministic local model endpoint where supported.
- [ ] Produce L1 and L2 receipts for Claude Code, Codex and GitHub Copilot CLI, then L3 and L4 after Task 2.
- [ ] Produce L2 receipts or recorded blockers for OpenCode, Hermes and Coven Code.

## Task 5: CI lanes and drift (#36)

- [ ] Add pinned per-harness lanes on macOS and Ubuntu with minimal permissions and no secrets.
- [ ] Add the scheduled, report-only drift workflow that files or updates one issue per broken harness.

## Task 6: Docs and permission guidance (#37)

- [ ] Add `docs/harnesses.md` with the evidence-linked matrix and one recipe per harness, synced to the recipe command by a test.
- [ ] Document which process needs macOS Screen Recording and Accessibility under each harness and launcher, marked verified or unverified.
- [ ] Confirm MCP and SDK repair hints name the right surface.

## Later, separately authorized

- Coven attachment: Coven-launched sessions attach the connector through each harness's native MCP mechanism (Claude `writeScope.mcpConfigFile`, and the Codex and Copilot equivalents). File this in OpenCoven/coven only after owner authorization.
- Release readiness: the MCP entry the recipes use ships in the paired release from #25. Stop before publishing.

## Iteration protocol

Each cycle: pick the lowest unmet cell in the matrix (Tier A before Tier B, lower levels before higher), write the failing conformance check, fix it, run `pnpm run check` and `pnpm run test:packed`, open the PR, and update the matrix and handoff. If a harness blocks a level (no custom endpoint, no stdio MCP, dropped images), record the concrete blocker and move on instead of stalling.

Pause and ask only for ADR sign-off, installing harness CLIs locally, paid provider usage, cross-repository Coven work, and merge or release.

## Evidence and handoff

Keep evidence in a sibling directory outside the repository (for example `../desktop-use-harness-goal-evidence/`) and keep its `handoff.md` current with exact heads, PR links, CI run and job IDs, the per-harness × level matrix with evidence links, a requirement-by-requirement audit, remaining blockers with next actions, and retained worktrees. Post sanitized checkpoints on the relevant issue.

## Done when

- Claude Code, Codex and GitHub Copilot CLI are each at L4 on pinned versions, with green CI lanes on macOS and Ubuntu, and OpenClaw gateway qualification is still green.
- OpenCode, Hermes and Coven Code are each at L2 or higher, or have a concrete recorded blocker.
- Tier C harnesses have checked L0 recipes labeled unqualified.
- The approval ADR is accepted and implemented, and no gated effect can be reached through any harness without trusted human approval.
- The `docs/harnesses.md` matrix matches the evidence, and the drift lane is running.
- All PRs are green and reviewed but unmerged, and the handoff is complete. L5 native acceptance is listed as separate gates, each with its concrete blocker.
