# Gateway contract qualification implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this authorized objective task by task, with one independent whole-branch review before delivery.

**Goal:** Qualify the dedicated computer-use agent on OpenClaw 2026.4.26 and deliver reviewed green PRs covering #12, #13, and #15 without merging or publishing.

**Architecture:** Keep authentication, approval resolution, tool policy, and agent execution in the actual gateway. The adapter owns truthful metadata, canonical request preparation, bounded process execution, and redacted audits. Use a disposable gateway and deterministic local model transport to exercise the actual agent/hook path without a paid provider or live user configuration.

**Tech stack:** TypeScript, tsx/node tests, the pinned OpenClaw npm package, local HTTP/WebSocket qualification, existing Rust CLI and checks.

**Spec:** User-authorized attachment /Users/buns/.codex/attachments/935350c0-fa74-4e7b-84b3-d4a11ded7221/pasted-text-1.txt; live GitHub issues #12, #13, and #15.

## Global constraints

- Minimum supported gateway is exactly 2026.4.26; receipts must record the observed version and package identity.
- Preserve PR #11 and other-session worktrees. Existing #12 and #15 worktrees are being edited independently; consume their eventual reviewed PR commits rather than taking over or duplicating their changes.
- Use only disposable state, configuration, workspace, credentials, files, and owned helper processes. Do not install desktop helpers, change privacy grants, read live credentials, merge, release, publish, or change #14 migration behavior.
- Keep prose paragraphs on one source line and preflight exact GitHub payloads before publishing.

## Review focus

- Tool profile layering must preserve computer_use while excluding prohibited built-ins, proven by actual runtime discovery and invocation rather than constant equality.
- Missing or ambiguous context must not resolve to a different session's workspace or approval; Stop must remain scoped when identities collide.
- Alias calls must take the same approval/canonicalization/cancellation path without enabling an unapproved alias for the dedicated agent.
- Approval denial, expiry, disconnected routes, and cancellation must prevent effects; success or a trusted operator HTTP call is not approval-flow evidence.
- The optional descriptor registration API may be absent; metadata must distinguish supported controls, host-produced state, and unavailable integration.

## Task 1: Establish isolated runtime and reproduce the policy mismatch

- [ ] Install pinned dependencies and run the unchanged baseline check; save logs outside temporary worktrees.
- [ ] Start a loopback-only gateway with unique state/config paths and disposable token, no channels, and the real plugin from an explicit load path.
- [ ] Capture runtime version, plugin loading, effective tool inventory, health result, and excluded-tool behavior for the original template and proposed profile policy.
- [ ] Retain the first failure and build a reusable qualification runner from the successful invocation path; do not patch or replace gateway internals.

## Task 2: Make Control UI contracts truthful (#13)

- [ ] Add a failing descriptor regression requiring only Stop and health controls, explicit action mapping, and ownership/availability for every state field.
- [ ] Update src/computer-use-agent.ts with metadata only, preserving gateway ownership of pause, approval revocation, and session state.
- [ ] Update docs/computer-use-agent.md with a field-by-field producer/availability table and descriptor integration limits.
- [ ] Run focused tests, the full check, and diff whitespace checks before committing with DCO sign-off.

## Task 3: Integrate policy and scope prerequisites (#12/#15)

- [ ] Refresh other-session PRs and exact heads; inspect their diffs and receipts without modifying their branches.
- [ ] Preserve prerequisite ancestry in this isolated branch and document explicit stack dependencies in the PR.
- [ ] Add any missing failing regressions for absent/ambiguous context, different agents/sessions/workspaces, and canonical approved paths; implement only gaps not already owned by another task.
- [ ] Verify profile/template/docs/health agreement and canonical names against manifests, preserving all legacy behavior outside #14.

## Task 4: Prove actual gateway behavior and deliver

- [ ] Exercise a deterministic local model transport through the real gateway agent to emit controlled tool calls; observe actual approval requests and resolve allow/deny through the gateway API.
- [ ] Wait for a real approval expiry without bypassing its configured deadline; verify no file effect. Verify canonical target descriptions and postapproval path rebinding.
- [ ] Exercise scoped Stop and gateway cancellation with owned stalled helpers; verify other-session work is unaffected and owned processes terminate within the documented bound.
- [ ] Verify audits in disposable agent directories contain no input/content markers; distinguish host transcripts and approval displays from redacted action audits.
- [ ] Save reproducible commands, sanitized receipts, exact trees/heads, per-requirement evidence, and outstanding graphical acceptance limits.
- [ ] Run pnpm run check, obtain independent review, address substantive findings, push scoped DCO-signed commits, create scoped PRs, resolve automated review findings, and verify exact-head macOS/Linux CI.
- [ ] Stop before merge/publication; mark the goal complete only when every requested gateway gate is proven and reviewed green PRs exist. If a gate remains unavailable, retain the full criterion and a concrete continuation command.
