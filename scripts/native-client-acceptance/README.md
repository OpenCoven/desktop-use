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

For macOS control-timing diagnostics, prepare a separate new directory with `--observe-controls`. This optional mode records actual text, scroll, key and click callbacks synchronously into a bounded scalar timeline, then coalesces complete state-file writes. Default preparation leaves this observer disabled. The existing 200 ms fixture heartbeat also publishes the current timeline during quiet periods. Callback timestamps use decimal nanosecond strings from `mach_continuous_time`; publication time and file modification time do not substitute for callback time. A dropped event, changed history prefix, lost focus, changed fixture identity or inconsistent text length, scroll offset or counters invalidates the proof. A same-length text replacement without a callback is outside this scalar check; actual callback coverage still needs native verification. Input text remains private fixture state and is absent from the observer timeline and proof result.

`mac-control-proof.mjs` validates a complete callback history across the first promise-settlement timestamp and a minimum 750 ms observation window. Its clock preflight is qualified specifically against Darwin libuv 1.52.1 and a separately compiled Foundation-only clock probe; this qualification does not restrict production SDK support. A matching clock bracket establishes clock-domain agreement, not a sub-millisecond calibration. The module does not establish that work was still active, that a helper was reaped or that pixels were stable; the native runner and independent UI observation must supply those separate facts. The existing security probes exercise pending approvals and must not be cited as active-input Stop acceptance.

The observer's Foundation tests and JavaScript proof tests need no fixture launch, helper invocation, privacy change or desktop input. Compile their outputs into a new task-owned directory. These checks validate instrumentation and proof logic; they provide no native acceptance by themselves.

```sh
swiftc -parse-as-library scripts/native-client-acceptance/ControlObservation.swift scripts/native-client-acceptance/control-observation-tests.swift -o /owned/new-tests/control-observation-tests
/owned/new-tests/control-observation-tests
node --test scripts/native-client-acceptance/mac-control-proof.test.mjs
node --test scripts/native-client-acceptance/mac-active-boundary.test.mjs
python3 scripts/native-client-acceptance/test_mac_owned_processes.py
python3 -B scripts/native-client-acceptance/test_mac_process_table.py
python3 -B scripts/native-client-acceptance/test_mac_continuous_clock.py
clang -fsyntax-only scripts/native-client-acceptance/mac-process-abi-check.c
```

`proveMacActiveBoundary` separately requires two fresh observations with actual text-growth callbacks spanning at least 25 ms, the same live helper with its exact prepared executable and birth identity, an unsettled call, stable fixture identity/focus and complete ordered history. Pending approval, one completed bulk edit, stale callbacks, stopped/zombie helpers and changed helper identities cannot qualify this boundary. Its observations come from the separate coordinator; the Node consumer must independently reject a cancellation trigger received after its call settled. The scalar observer UI displays input length for independent pixel observations.

`mac_owned_processes.py` provides read-only ownership logic for the separate coordinator. It registers only a complete descendant traversal of a bound root, checking executable and microsecond birth identities plus parent relationships before and after acquisition. Previously bound descendants remain tracked after reparenting; PID reuse cannot transfer ownership. An executable change on the same process raises an unresolved-ownership error, and a zombie remains unreaped. The Darwin backend reads only requested process metadata and direct child lists through `libproc`; denied, short or ambiguous reads fail visibly instead of reporting an empty tree. SDK layout checks are independent of the injected binding tests. Birth bracketing around an executable lookup is not an atomic process snapshot: revalidate executable and birth before cleanup or acceptance decisions, and retain ambiguity on change. This API never signals a process or proves reaping by itself.

The optional integration below launches only an isolated Python child of the test process. It verifies actual process birth, the exact kernel-reported interpreter image, ancestry and absence after explicit child wait/reaping. Framework Python launchers can re-exec `Python.app`, so comparing to the launcher pathname is insufficient. The child has no desktop actions or descendants, exits after two seconds, and readiness/wait/cleanup are bounded. This process-only test does not qualify AppKit callbacks, desktop cancellation or an active-input runner.

```sh
NATIVE_ACCEPTANCE_OWNED_PROCESS_TEST=yes python3 -B scripts/native-client-acceptance/test_mac_process_table.py
```

The active macOS runner uses a separate newly prepared directory with `--observe-controls`; preparation copies and hashes its client/coordinator modules and checks the selected SDK ABI. Keep earlier prepared apps and receipts frozen. Launch the new fixture only after the operator has explicitly unlocked the session and returned the exclusive native window. The coordinator checks the exact live fixture executable, birth identity, window, fresh control state and prepared adapter/helper/script bytes. It launches no app and changes no OS privacy settings.

Invoke one case at a time with the prepared Pillow interpreter and an absolute Node executable. Supply `PEEKABOO_CAPTURE_ENGINE=cg` only when selecting that separately recorded backend. A fresh exclusive lease must have more than 100 seconds remaining immediately before consumer spawn. Execution is bounded to 55 seconds with 35 seconds reserved for draining and cleanup; the owner retains the session until actual terminal recovery. Non-optimized Python is required so fixture assertions remain active.

```sh
/owned/acceptance-venv/bin/python /owned/new-run/consumer/mac-active-coordinator.py --root /owned/new-run --node /absolute/path/to/node --surface sdk --mode stop --lease-expires-at 2026-11-14T23:00:00Z --owned-unlocked-fixture
```

The seven-case matrix is SDK Stop, Abort and timeout, then modern and legacy MCP Stop and timeout. Each case uses a fresh private workspace and scope, the actual installed SDK or terminal reference host, a real decoded readiness image and the owned accessible input field. The coordinator requires continuing actual text growth over at least 25 ms with the same live helper before triggering interruption; it adds no production typing delay and never freezes a Mac helper. Timeout retains its two-second action deadline. A missed active boundary or helper-disappearance timing gap remains unqualified.

The Node child stamps its first input-promise callback immediately, before await, process inspection or history validation. The coordinator sends only a bounded scalar trigger during input; complete history proof runs afterward. Scoped Stop acknowledgement is recorded separately because the shared API reports `state: cancelling` while cleanup continues. The control classifier preserves the input-promise settlement cutoff and rejects every callback at or after it across at least 750 ms. It does not imply that the earlier Stop acknowledgement completed cancellation.

Before/after window PNGs and complete raw responses stay in each private case directory for independent UI inspection. Their hashes are included in the client receipt; scalar callback proof cannot substitute for reading the actual pixels. Connector closure and direct-child reaping are attempted independently after faults. Previously bound orphan identities require exact executable/birth revalidation before signals; zombies and denied inspection retain unverified cleanup. Known-actor cleanup does not establish kernel containment of an unobserved orphan. Retain the first failed receipt and exclusive fixture ownership until recovery is verified.

Negative probes require a stable live fixture PID and actual fixture input focus before and after cases, plus a real image through their own configured client/connector. Stale state, changed focus or an unavailable backend fails the probe. Linux also binds the recorded fixture PID to its running command and active X11 window, requires the explicit owned X11 flag/session, and forwards that display to the connector; unrelated environment values are not forwarded. Configure-event tracking keeps the GTK fixture's reported origin current after window-manager placement.

The GTK fixture captures each event and its timestamps immediately, while coalescing complete state-file writes onto a 16 ms default-priority timer per burst, with a final pending flush on shutdown. This preserves every event and its order while avoiding repeated serialization of the growing history inside key handlers. File-only coalescer tests do not prove stable visible UI after Stop; repeat affected native cases with the same event classifier, deadlines and held-key boundary before making that acceptance claim. Previously queued events delivered after promise fulfillment remain a separate reported limit.

For cancellation timing diagnostics, the fixture's optional `--observe-controls` flag also records each actual Entry `changed` and adjustment `value-changed` callback immediately in `controlChanges`, with a monotonic nanosecond timestamp, text length, scroll offset and key count. The existing coalesced writer publishes the complete ordered timeline; its file modification time is not the control-change time. This observer adds no per-event file writes and retains no input contents. Control callbacks establish when widget values changed; independent pixel observations are still needed to assess rendering, and callback timestamps alone do not prove visible stability at promise fulfillment.

## Owned virtual Linux X11

The installed Linux client requests both full-screen and frontmost PNG/JPEG captures through the SDK and both MCP revisions. Each capture is bracketed by independent read-only X11 root/window geometry, focus, PID and process-birth queries. The verifier requires stable owned-window identity and exact decoded dimensions, scope metadata and complete image-to-desktop rectangles; a broader display image cannot satisfy a frontmost request. Four landmarks and resized coordinates remain checked before input. These assertions need a new native execution receipt; pure tests and earlier screen-only/provider receipts do not establish the new extent proof.

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

## Owned software Wayland

`wayland-operator.py` ports the supported image/type/key matrix into a reusable installed-consumer probe. It performs only metadata preflight by default. Execution requires a separate disposable Linux namespace running as a non-root user, no `/dev/input` or `/dev/uinput`, explicit display opt-in, a fresh output directory and a coordinated timezone-qualified lease of 60–1,200 seconds. Use a prepared Sway 1.7 software compositor with headless/pixman rendering, one `HEADLESS-1` output at origin zero, GTK 3/GdkPixbuf, Node 22.14 or newer, Python 3, `swaymsg`, `wayland-info`, `wtype`, and a separately verified JPEG-enabled `grim` build. The operator installs nothing, passes no devices through and changes no desktop or privacy settings. A build with JPEG disabled must fail the JPEG case; installing a helper does not prove capture support.

Prepare an installed consumer outside the repository using one exact paired package/native candidate and the actual MCP client dependency. The private `--prepared` JSON must contain `schemaVersion:1`, product `sourceCommit`/`sourceTree`, harness `harnessCommit`/`harnessTree`, absolute `consumerRoot` and `packageRoot`, `adapterPath`/`nativeSha256`, `packageArchivePath`/`packageArchiveSha256`, and `installedFiles` mapping every package-relative regular filename to its SHA-256. `harnessSources` maps every repository-relative entry in `PUBLIC_SOURCE_FILES` from `wayland-operator.py` to its reviewed source hash. Supply these revision identities and expected artifact hashes from the owner handoff. Generate the complete inventories from those exact bytes, then retain the descriptor privately; the operator rejects changed files, symlinks, missing compiled public exports and any difference between the installed file set and the bound tarball.

The descriptor's `tools` object has exactly seven entries: `sway`, `swaymsg`, `grim`, `wtype`, `wayland-info`, `node` and `python3`. Each contains an absolute canonical executable `path` and its `sha256`. The constructed PATH must select those exact files; an ambient helper or a changed JPEG build fails preflight. The source-bound interpreter must be named `python3` or `python3.<minor>`. No source checkout, credentials, private host environment or unrelated desktop state belongs in the disposable namespace.

```sh
python3 -B scripts/native-client-acceptance/wayland-operator.py --prepared /owned/prepared.json
NATIVE_OWNED_DISPOSABLE_DISPLAY=yes python3 -B scripts/native-client-acceptance/wayland-operator.py --prepared /owned/prepared.json --output-root /owned/fresh-scale1 --scale 1 --lease-expires-at "$WAYLAND_FIXTURE_LEASE_EXPIRES" --owned-disposable-display --execute
```

Run scale 2 separately with a fresh namespace, output directory and lease. Both cases use a 1280×960 physical output; scale 2 has a 640×480 logical desktop. The client brackets actual SDK and both stdio MCP PNG/JPEG images with independently PID/UID/birth-bound Sway output and window metadata. The complete physical image, logical desktop rectangle, scope, decoded format and timestamps must agree before all four landmarks and a consumer resize can pass. The four named landmarks are fixture content markers; their names do not imply they span the entire full-screen raster. Approved text and key actions must change the actual Entry, while unsupported frontmost capture and unavailable pointer input must return no image or control effect. Overall health remains false when the platform is only partially available.

All metadata filesystem/proc/hash/IPC work in each snapshot runs synchronously inside one isolated Python child with bounded input/output and reads. The Node parent requests SIGKILL on its four-second timeout and waits for actual worker termination before returning an outcome. This is containment, not a hard return deadline when an OS syscall cannot promptly terminate. The operator retains a monotonic budget alongside the wall-clock lease, reserves cleanup time, tracks its process groups and adopts detached descendants as a subreaper. Signal handling defers repeated interruption during cleanup. Retain exclusive namespace ownership if reaping or cleanup fails; elapsed lease time alone does not establish recovery.

Returned images, raw fixture input/state, terminal prompts, configurations and unrestricted logs remain private. `receipt.json` contains scalar/hash proofs, relative source inventories and explicit limits; `operator-status.json` separately records actual child cleanup and the independently captured final fixture image hash. Inspect that actual image independently before accepting UI effects. These files do not establish active cancellation, delayed-input completion, the official provider path, physical display behavior or a published release. Earlier native receipts retain their original source bindings and cannot qualify a changed public harness or a new scale.

```sh
node --test scripts/native-client-acceptance/wayland-scope-proof.test.mjs scripts/native-client-acceptance/wayland-owned-snapshot.test.mjs scripts/native-client-acceptance/wayland-run-contract.test.mjs
python3 -B -m unittest discover -s scripts/native-client-acceptance -p 'test_wayland_*.py'
```

These pure/injected tests use synthetic compositor/metadata replies and small mock worker processes. They launch no graphical session and provide no native acceptance.

## Evidence and cleanup

Only copy allowlisted metadata, hashes, observations and pass/fail projections into durable evidence. Raw image blocks, helper responses, terminal reviews and full audit records stay in the private disposable run. Record failed and superseded attempts separately, including source, package/native/helper identities, backend selection and actual runtime. Do not overwrite earlier failures or treat unavailable geometry as identity.

Source/schema checks and fixtures do not establish publication, official-host qualification, physical desktop acceptance or a successful paired release. Restore only owned fixture processes, displays and runtime resources after explicit leases have ended; preserve other sessions and all frozen release artifacts.


The current Linux full-control continuation adds four labelled colored landmarks, an actual editable Entry and an overflowing scroll viewport. Updated positive clients require all four landmark colors in received PNG/JPEG pixels, an exact change in the editable value, and an actual bounded viewport-offset change through approved native actions. Key counts and wheel-event counts cannot substitute for those control effects. These changes have file-only verifier tests; the frozen earlier ea/b114 fixture/image and its diagnostic receipts retain their original identities. Fresh native installed-client and independent UI qualification is required before claiming the new controls pass.


The macOS fixture also draws four labelled corner landmarks outside the existing target, text field and scroll area. Its pixel verifier checks their independent content coordinates through the full decorated-window mapping after ICC conversion, with the declared 16-level sRGB tolerance. Synthetic PNG/JPEG regressions cover Retina scale, negative desktop origin, missing landmarks and incorrect landmark geometry. The prior compiled fixture and native receipts retain their old hashes; the updated fixture requires separate compilation and actual unlocked-session qualification.
