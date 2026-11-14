# Native client acceptance

These opt-in probes use real adapter/helper processes and disposable graphical fixtures. They must never run against an unrelated desktop. Packed consumer, virtual X11, native macOS, physical display, human decisions and public release evidence remain distinct.

## macOS

Use Node.js 22.14.0 or newer, a Python interpreter with Pillow/ICC support, and the macOS Swift compiler. The verifier was qualified with Python 3.15.1 and Pillow 13.0.0. Install its pinned dependency into a task-local virtual environment and invoke preparation with that interpreter; preparation records it and the clients use its absolute path for verification and the terminal broker. It checks these imports before launching any native work.

```sh
python3 -m venv /owned/acceptance-venv
/owned/acceptance-venv/bin/python -m pip install -r scripts/native-client-acceptance/requirements.txt
```

Build and pack one source revision sequentially. Peekaboo 4.9.8 needs the compatibility and qualified geometry fixes proposed in [PR #39](https://github.com/OpenCoven/desktop-use/pull/39); this harness does not supply or bypass missing production behavior. Verify the official helper download separately, then supply its extracted directory; preparation performs no helper installation, fixture launch or privacy change. The output directory must not exist. The package guard requires the actual compiled public exports and executable before installation and compares every installed package file with its archive.

```sh
pnpm run check
cargo build
pnpm pack --pack-destination /owned/artifacts
/owned/acceptance-venv/bin/python scripts/native-client-acceptance/prepare-macos.py --root /owned/new-run --package /owned/artifacts/candidate.tgz --adapter target/debug/coven-desktop-use --peekaboo-directory /owned/helper
```

Launch only the generated `DesktopUseAcceptance.app`, then use every entry in its `run-env.json` as environment variables, including `PATH`. Before any native action, the clients verify the prepared adapter hash and the resolved helper path/hash; an ambient or changed helper fails preflight. Keep the Mac unlocked and put the fixture on the current Space before input, using its explicit window identity; do not weaken a helper's off-screen refusal. Run each client sequentially so it exclusively owns fixture effects. `PEEKABOO_CAPTURE_ENGINE=cg` selects an explicit helper backend and is recorded separately from `auto`; it does not turn a failed auto capture into a pass.

```sh
node /owned/new-run/consumer/native-client.mjs sdk
node /owned/new-run/consumer/native-client.mjs mcp-modern
node /owned/new-run/consumer/native-client.mjs mcp-legacy
node /owned/new-run/consumer/sdk-security.mjs
node /owned/new-run/consumer/mcp-security.mjs
```

The positive clients require a real pixel-derived target mapping and observed fixture click, key, text and scroll changes. The full capture extent and pixel scale must match the fixture's independent AppKit window frame and backing scale; a screen capture containing the right landmark cannot prove window scope. Pixel checks decode the actual received image and apply its ICC profile; the declared 16-level sRGB tolerance accommodates display conversion/dithering while the exact encoded bytes remain hash-bound. Resizing is performed by the test consumer and is not gateway-history qualification. Six verifier regressions reject missing pixels, wrong hashes, unsupported or wrong geometry, broader capture scope and the wrong target state. Independently observe the fixture UI before accepting its result.

The SDK provider decisions and terminal broker operator decisions are scripted test decisions. They are not human approval acceptance. The MCP connector is the actual installed stdio executable behind the actual separate terminal reference host, on both wire revisions.

Negative probes require a stable live fixture PID and actual fixture input focus before and after cases, plus a real image through their own configured client/connector. Stale state, changed focus or an unavailable backend fails the probe. Linux also binds the recorded fixture PID to its running command and active X11 window, requires the explicit owned X11 flag/session, and forwards that display to the connector; unrelated environment values are not forwarded. Configure-event tracking keeps the GTK fixture's reported origin current after window-manager placement.

The GTK fixture captures each event and its timestamps immediately, while coalescing complete state-file writes onto a 16 ms default-priority timer per burst, with a final pending flush on shutdown. This preserves every event and its order while avoiding repeated serialization of the growing history inside key handlers. File-only coalescer tests do not prove stable visible UI after Stop; repeat affected native cases with the same event classifier, deadlines and held-key boundary before making that acceptance claim. Previously queued events delivered after promise fulfillment remain a separate reported limit.

## Owned virtual Linux X11

Stage a minimal context instead of sending a checkout or private state to Docker. The pinned images describe this test environment, not the supported native release matrix. Start the resulting container without host mounts, published ports, devices or networking; the isolated Xvfb display is not a physical desktop.

```sh
python3 scripts/native-client-acceptance/prepare-linux-context.py --package /owned/artifacts/candidate.tgz --output /owned/new-linux-context
docker build -t desktopuse-native-acceptance /owned/new-linux-context
docker run -d --name desktopuse-native-acceptance --network none --shm-size 256m desktopuse-native-acceptance
```

Inside that owned container, start `Xvfb :91 -screen 0 1280x960x24 -nolisten tcp`, save its actual PID to `/owned/xvfb.pid`, and start Openbox with `DISPLAY=:91`. Run the existing `fixture/qualify.py` with `--owned-disposable-display` and the actual server PID. For installed-client probes, launch the GTK fixture titled `DesktopuseInstalledClient`, with state `/owned/fixture-client-state.json`, and record its actual PID in `/owned/client-fixture.pid`. Wait for matching readiness before input. Set `DISPLAY=:91`, `XDG_SESSION_TYPE=x11` and `NATIVE_OWNED_DISPOSABLE_DISPLAY=yes` only for this owned environment.

```sh
node /owned/consumer/linux-client.mjs
python3 /owned/active-cancellation.py
node /owned/consumer/input-queue-diagnostic.mjs
```

For the negative clients, first complete the positive client flow so the fixture and its keyboard oracle have been observed working. Keep that same fixture focused; these probes verify focus and never move it themselves.

```sh
mkdir -p /owned/negative-sdk /owned/negative-mcp
export NATIVE_ACCEPTANCE_ADAPTER=/owned/source/target/debug/coven-desktop-use
export NATIVE_ACCEPTANCE_FIXTURE_STATE=/owned/fixture-client-state.json
export NATIVE_ACCEPTANCE_PTY=/owned/pty-host.py
NATIVE_ACCEPTANCE_ROOT=/owned/negative-sdk node /owned/consumer/sdk-security.mjs
NATIVE_ACCEPTANCE_ROOT=/owned/negative-mcp node /owned/consumer/mcp-security.mjs
```

The active-cancellation outer guard adopts detached descendants as a Linux subreaper and terminates/reaps every owned descendant before resuming the same dedicated Xvfb server. It also handles SIGTERM and SIGINT; a cleanup failure retains the exclusive display lease for recovery and must not be treated as a pass. Capture cases check actual helper liveness, cancellation/timeout, reaping and destination preservation. Input cases require a matching ready fixture, successful focus, observed input before Stop and no later fixture input. A failed input case remains failed even when its helper was reaped; preserve held-key and event-timestamp evidence. Never disable auto-repeat to mask that result. On failure, release only synthetic keys introduced by the test in this isolated display and verify that key state and fixture counters return to a stable baseline before another owner uses it.

For the separate native OpenClaw driver, `gtk-openclaw-state.mjs` projects this GTK fixture into a flat counter/window receipt without changing the fixture or exposing raw event contents. Supply the observed owned Xvfb PID as `FIXTURE_XVFB_PID`; the output must be a new private path. Keep the bridge running through the exclusive fixture lease.

```sh
node /owned/acceptance/gtk-openclaw-state.mjs /owned/fixture-client-state.json /owned/client-fixture.pid /owned/fixture/fixture.py "$FIXTURE_XVFB_PID" /owned/new-openclaw-fixture-state.json --owned-disposable-display
```

Each bridge observation binds live fixture/server process start identities, the actual Python fixture invocation and display, matching active-window/PID probes, and independent borderless X11 geometry matching GTK origin/extent at both ends of acquisition. Geometry and identities must stay stable within a one-second acquisition budget; timestamps retain acquisition start. Sampling is a bounded stability check, not an atomic desktop snapshot. The bridge exports counts, fixed fixture target bounds, process identities and freshness metadata, and invalidates its output on failure or handled termination. The OpenClaw consumer must independently require the selected bridge script/hash, live bridge and GTK identities, and a receipt no older than one second after all asynchronous validation. A stale state file cannot substitute for a live oracle. These source/contract checks establish no native/provider-chain or Stop acceptance until the real owned run is observed.

The non-native verifier and identity tests can run without launching a fixture. The process-guard regression requires Linux but no graphical session; it checks actual detached descendants after normal parent exit and after a parent timeout.

```sh
python3 -m unittest scripts/native-client-acceptance/test_image_proof.py
node --test scripts/native-client-acceptance/identity-preflight.test.mjs
node --test scripts/native-client-acceptance/gtk-openclaw-state.test.mjs
python3 scripts/native-client-acceptance/test_owned_process_guard.py
```

## Evidence and cleanup

Only copy allowlisted metadata, hashes, observations and pass/fail projections into durable evidence. Raw image blocks, helper responses, terminal reviews and full audit records stay in the private disposable run. Record failed and superseded attempts separately, including source, package/native/helper identities, backend selection and actual runtime. Do not overwrite earlier failures or treat unavailable geometry as identity.

Source/schema checks and fixtures do not establish publication, official-host qualification, physical desktop acceptance or a successful paired release. Restore only owned fixture processes, displays and runtime resources after explicit leases have ended; preserve other sessions and all frozen release artifacts.


The current Linux full-control continuation adds four labelled colored landmarks, an actual editable Entry and an overflowing scroll viewport. Updated positive clients require all four landmark colors in received PNG/JPEG pixels, an exact change in the editable value, and an actual bounded viewport-offset change through approved native actions. Key counts and wheel-event counts cannot substitute for those control effects. These changes have file-only verifier tests; the frozen earlier ea/b114 fixture/image and its diagnostic receipts retain their original identities. Fresh native installed-client and independent UI qualification is required before claiming the new controls pass.


The macOS fixture also draws four labelled corner landmarks outside the existing target, text field and scroll area. Its pixel verifier checks their independent content coordinates through the full decorated-window mapping after ICC conversion, with the declared 16-level sRGB tolerance. Synthetic PNG/JPEG regressions cover Retina scale, negative desktop origin, missing landmarks and incorrect landmark geometry. The prior compiled fixture and native receipts retain their old hashes; the updated fixture requires separate compilation and actual unlocked-session qualification.
