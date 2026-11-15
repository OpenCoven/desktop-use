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

### Task 3: Independent complete-window extent qualification

**Scope:** The native owner handed off only `scripts/native-openclaw-acceptance/**` and this plan from preserved `620b950`. Continue in a separate isolated worktree. No product, X11, release, fixture or active owner branch changes are authorized by this handoff. The current macOS adapter truthfully reports provider scope unavailable; retain that field verbatim.

**Files:** Modify `wire-proof.mjs`, `wire-proof.test.mjs`, `fixture-lease.mjs`, `fixture-lease.test.mjs`, `run.mjs` and `README.md` under `scripts/native-openclaw-acceptance/`.

**Interface:** `proveWireObservation(body, marker, { sharp, fixture, platform, expectedCallId, captureStartedAtMs, seenObservationIds })` requires independent macOS `windowFrameRect` and `backingScale`; it returns `independentWindowExtentVerified` separately from unchanged `actualScope`. The Linux frontmost scope assertion remains required. Lease checks freeze the frame and scale before capture and input.

**Review focus:** Reject a broader screen containing the correct landmark, cropped images with correct target coordinates, missing or inconsistent frame/scale, contradictory scope metadata, and a frame or scale changed after capture. Full-window extent establishes footprint within declared tolerance, not semantic ownership of every pixel.

- [x] Run the preserved focused suite as a baseline, then add real encoded-image regressions for broader/cropped rasters, absent frame/scale, nonuniform or unqualified scale, contradictory provider scope and changed lease metadata. Retain the expected failures before implementation.
- [x] Require one region covering the complete decoded raster and matching the independent AppKit window frame within one point per edge; require uniform 1x or native backing scale within 0.01. Preserve the hash, freshness, current-call identity, target-edge and no-overlap checks. Assert the separate independent proof in the driver before emitting input.
- [x] Run the entire focused suite and syntax checks, review the complete branch, and run the repository check before opening a focused PR. Native/gateway execution remains pending explicit unlock and a fresh final-byte fixture lease.

Task 3 review: a fresh whole-branch reviewer reproduced three important findings. Both scale axes must satisfy the same allowed-scale tolerance; pending setup must settle before cancellation cleanup can finish; and a gateway that already exited cannot certify that no detached child survived. Four additional regressions failed before the fixes and the focused suite passed 52/52 afterward. The driver now retains observed child/start identities while the leader is alive and fails closed on incomplete ownership after an unexpected leader exit. No review findings were deferred. Full-window extent remains independent footprint evidence, without upgrading the provider's unavailable scope or certifying every pixel's semantic ownership.

Task 3 validation: the full repository check passed after review fixes (326 TypeScript tests, 26 gateway-fixture tests, seven import-graph tests, 74 source/compiled boundary files, 94 Rust tests and one CLI cancellation integration; one preexisting ignored Rust fixture). All 52 focused harness tests also passed using dependencies supplied by a separately installed official OpenClaw 2026.4.26 package with Sharp 0.34.5. Read-only preflight verified all 91 installed plugin files and all 9,084 official host archive files on the retained source57 candidate. Native test binaries used synthetic helpers; no graphical fixture or official gateway was executed by this continuation.


### Task 4: Independent Linux provider capture extent

The old Linux provider receipt reported `independentWindowExtentVerified:false`; it remains immutable. Read/copy authorization binds the scope collector, identity helpers and scope tests to PR40 source `8c7cab90e28a34355868e9518edee277af50c925`. Only this PR44-owned harness revision changes. Derive raw GTK state from the verified bridge invocation, capture independent X11 snapshots before capture and after provider-wire arrival using the same consumer clock, and require the entire decoded raster and mapping to match the unchanged focused fixture footprint before input. Preserve the macOS proof, current-call/freshness/hash/MIME checks, privacy, default read-only preflight and exclusive fixture lease.

Eleven new behavior checks reproduced missing extent enforcement: 53 tests ran with eleven expected failures. After exact helper copying and gate integration, the complete focused suite passes 156 tests, including forty handed-off scope/collector checks. Two earlier host-selection failures are retained: the project OpenClaw dependency lacked Sharp, and the outer disposable install directory lacked official replay/resolver modules; select the actual inner official OpenClaw package, without modifying dependencies or tests. Full repository check and packed consumers pass. Fresh review and a source-bound native provider run are still required; no previous native receipt is upgraded by these source/test results.
