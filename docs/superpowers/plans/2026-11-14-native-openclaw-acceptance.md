# Native OpenClaw acceptance implementation plan

> For agentic workers: use superpowers:executing-plans for inline implementation and a fresh final reviewer.

**Goal:** Prove the actual packed plugin delivers fixture-native pixels to an official OpenClaw model request, derives the intended coordinates from those pixels, and performs exactly one approved fixture effect while denial produces none.

**Architecture:** A separate opt-in driver uses a fresh private gateway state root and a deterministic loopback model server. An independent pixel verifier rejects missing, ambiguous, mismatched or unmappable content before the model emits a coordinate click. Existing release qualification and native-owner source/session paths are untouched.

**Tech stack:** Node 22.14 or later, official OpenClaw 2026.4.26, its pinned Sharp 0.34.5 and ws, installed packed plugin, actual native adapter, explicitly handed disposable fixture.

**Spec:** User goal attachment `423313ad-c220-4a09-b20b-8798aac33828/pasted-text-1.txt`; native owner granted this uncovered OpenClaw slice and requires explicit fixture/final-binary handoff before native execution.

## Global constraints

- No native capture/input or fixture launch before the explicit handoff.
- Use only an owned fixture window on macOS or an owned disposable Linux display; never full user desktop capture.
- Preserve exact source/package/native/helper/official-host identities. A changed native fix cannot inherit frozen 7b pairing.
- No hosted release matrix, live model provider, PR30 source edits, TCC changes or publication.
- Retain sanitized hashes, dimensions, mappings, counts and outcomes; provider images, input, tokens and full histories stay out of durable diagnostics.

## Review focus

- Old images from a prior turn must not authorize the current click.
- Wrong hashes, dimensions, target colors or ambiguous mappings must stop before input.
- Model-controlled confirmation must still reach a real host approval and denial must preserve fixture state.
- A helper exit or gateway completion is not a visible effect; independent fixture state and post-effect pixels must agree.
- Failure/timeout must close only the owned gateway/model resources and retain a sanitized partial receipt.

### Task 1: Provider-wire pixel proof

**Files:** create `scripts/native-openclaw-acceptance/wire-proof.mjs` and `wire-proof.test.mjs`.

**Interface:** `proveWireObservation(body, marker, { sharp, fixture })` returns only a sanitized image/mapping proof. It requires exactly one image and one observation in the current marked turn and binds decoded target pixels to independent fixture bounds.

- [ ] Write real PNG encode/decode tests for a valid scaled/negative-origin mapping and rejection of wrong hash, MIME, dimensions, missing/duplicate images, old-turn substitution, unavailable/overlapping mapping and missing target pixels.
- [ ] Run `node --test scripts/native-openclaw-acceptance/wire-proof.test.mjs` and retain the first failing result.
- [ ] Implement the bounded verifier and run the complete focused test command to green.

### Task 2: Opt-in official-host native driver

**Files:** create `scripts/native-openclaw-acceptance/run.mjs` and `README.md`; no shared qualification files change.

**Interface:** descriptor file names exact installed package, host, native binary, fixture state and expected identities. Default `--preflight` verifies files/identities without gateway/helper execution. `--run-owned-fixture` additionally requires the explicit handoff acknowledgement and a fresh private runtime root.

- [ ] Implement strict preflight and a focused fail-closed preflight test that needs no desktop.
- [ ] Use a loopback model and one isolated gateway session for capture → verified pixels → coordinate click → after-capture, plus a second capture/click whose forged confirmation is denied through actual approval RPC.
- [ ] Verify actual fixture counters and post-effect pixels; inspect audit/logs for forbidden payloads; retain sanitized receipts and bounded owned-resource cleanup.
- [ ] Exercise offline preflight and focused tests now. Execute native cases only on a handed final binary and fixture. Run required repository checks before any PR; obtain fresh review before delivery.

## Execution ledger

The detailed user goal already authorizes the implementation and autonomous checks. Inline execution preserves the current method. Task 1 proof is synthetic test evidence only. Task 2 native execution remains gated on the actual fixture/final-byte handoff; no elapsed time substitutes for that handoff.
