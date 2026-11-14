# Scoped X11 Pointer Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Release only a cancelled click's newly held intended button after reaping its helper, preserving unrelated state and truthful cleanup evidence.

**Architecture:** Extend the owned private guardian with a pointer transaction and distinct fixed-size reply marker. Route the existing click command through it and project only bounded cleanup counts across the SDK boundary. This branch depends on unchanged PR #45 source986; native integration and final acceptance remain separate.

**Tech Stack:** Rust, existing Xlib/XTest/libxdo, TypeScript, pinned MCP client and owned Python fixture probes.

**Spec:** `docs/superpowers/specs/2026-11-14-x11-pointer-cancel-design.md`.

## Global Constraints

- Preserve the existing 100 ms cleanup watchdog, 40 ms reap reserve, action deadlines, helper argv, approval policy and private import boundary.
- Arm only the current button in 1..=5; preserve preheld/unrelated buttons, keyboard state and pointer position.
- Keep keyboard reports at `0xd1`; pointer reports use `0xd2` with the same eight-byte bound. Publish only additive `releasedButtons` counts in 0..=5.
- Keep source986 and its canonical seven-case scripts/artifacts unchanged. Retain the first failing native receipt and separate manual recovery.

## Review Focus

- Parent death or cancellation between arming and exec must not allow input after helper quiescence; test the owned registration/cleanup path and an actual held helper.
- Preheld intended buttons and concurrent unrelated buttons must survive; test both scoped state and actual native observations.
- Pointer motion or unrelated keyboard-map changes must not authorize broad restoration or prevent release of a newly held intended button; test the pointer-only path.
- Pending acknowledgements must not shift pointer reports; exercise actual IPC framing and malformed count rejection.
- Missing/malformed cleanup through SDK/MCP must remain unverified; test sanitization and interrupted click fallback.

## Task 1: Scoped pointer state and guardian protocol

**Files:** `src/x11_input/state.rs`, `src/x11_input/xlib.rs`, `src/x11_input/guard.rs`, `src/x11_input/mod.rs`.

**Interfaces:** `Scope` gains current `button_release_candidates` and accumulated `button_restore_candidates`; `Compensation` gains `release_buttons`. `Guard::button(button: u8, deadline: Instant) -> bool` begins a pointer transaction through `Context::begin_pointer(button: u8) -> bool`. Pointer cleanup returns the existing eight-byte report with internal kind2; the private reply marker distinguishes it from keyboard reports.

- [x] Add state regressions for newly held intended buttons, preheld and unrelated buttons, completed/empty intent, unchanged-pointer restoration, moved-pointer uncertainty, untouched keyboard/lock/group state and invalid button ids.
- [x] Run `cargo test --locked --offline x11_input::state` and observe genuine missing-behavior failures after minimal type scaffolding.
- [x] Implement scoped button compensation and pointer-only snapshot/verification, preserving existing keyboard behavior.
- [x] Add private IPC tests proving pointer reports survive a pending acknowledgement and reject malformed pointer counts/flags.
- [x] Run focused Rust tests on macOS and Linux; retain exact terminal results before committing the guardian change.

## Task 2: Click integration, safe projection and native qualification

**Files:** `src/main.rs`, `src/process-runner.ts`, `src/process-runner.test.ts`, `src/plugin-safety.test.ts`, `src/core/execution.ts`, plus opt-in pointer qualification scripts.

**Interfaces:** The X11 click runner uses `Guard::button`, the existing observed process helper and guardian finish. `InputCleanup.releasedButtons?: number` is validated in 0..=5. Interrupted canonical click variants receive the existing unverified fallback when proof is absent.

- [ ] Write and observe failing TypeScript tests for valid/invalid releasedButtons projection and interrupted click fallback without raw diagnostics.
- [ ] Route the unchanged click argv through the guardian, attaching before helper exec and recording partial/input-start facts.
- [ ] Run `pnpm run check`, production packed consumers and Linux Rust tests on the final source; preserve all existing assertions.
- [ ] Freeze a new matching native/package pair with complete source/input/package hashes; do not rebuild after freezing.
- [ ] On a fresh explicit owned fixture lease, rerun the actual CLI pointer probe and SDK/both-MCP Stop cases; require real button-down across 25 ms, helper reaping and released state before test recovery.
- [ ] Run the canonical keyboard regressions on the frozen candidate, obtain fresh review, publish a focused dependent PR and require green exact-head CI. Revalidate final integration after the parent lands; keep all remaining #21 gates open.
