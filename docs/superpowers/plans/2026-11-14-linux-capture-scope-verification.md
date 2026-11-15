# Linux capture scope verification

The existing installed client verifies full-screen pixels and mapping. It does not independently reject a full-display raster returned for a frontmost request. Extend the PR40-owned harness only; preserve production artifacts and the frozen provider workflow.

1. Add pure failing tests in `scripts/native-client-acceptance/linux-scope-proof.test.mjs`: exact frontmost and screen geometry pass; broader crop, wrong origin, mismatched decoded size, changed focus/window/process birth, stale bracket, unknown scope and nonzero border fail.
2. Implement `linux-scope-proof.mjs` with a bounded read-only owned-X11 geometry collector and pure proof. Bracket captures with independently queried active window, window PID, process birth, xwininfo window/root rectangles and timestamps. Require stable fixture identity and geometry, matching requested/actual scope, decoded dimensions and complete image-to-desktop rectangle.
3. Extend `linux-client.mjs` to run PNG/JPEG in screen and frontmost modes on SDK and both MCP revisions. Add actual decoder dimensions to `linux-image-proof.py` output, retaining all four landmark, derived coordinate, resize and input assertions. Record scope proofs separately.
4. Run focused pure tests, parsing, the complete local check and source review. Commit a fresh source revision and obtain hosted results when ready. Prepare a new hash-bound native context; execute it only in a newly coordinated disposable runtime window. Synthetic tests alone do not qualify native scope.

Keep private pixels and raw X11 output outside durable diagnostics. Existing cancellation and earlier source-bound receipts stay unchanged. No test deadline, held-input boundary or no-delayed-input requirement changes.
