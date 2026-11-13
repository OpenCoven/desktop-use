# Image geometry and native qualification

Geometry describes the owned source raster, while `coordinateReference` retains its normalized 0–1 extent through host resizing. For a region, use `desktopX = desktopRect.x + (imageX - imageRect.x) * desktopRect.width / imageRect.width`, and likewise for Y. Convert a normalized point to source pixels using `coordinateReference.sourceExtent` first. Points in gaps between regions have no supported mapping. An available capture mapping and a successful input helper do not establish that a click reached its target.

| Producer | Supported geometry | Explicit limits |
| --- | --- | --- |
| scrot 1.8.1 or maim 5.7.4 with xwininfo 1.1.5 | X11 root screen and borderless active-window/frontmost origin and extent | Before/after target and geometry must agree with the decoded owned raster; bordered, clipped or changing windows remain unavailable |
| grim with swaymsg 1.7 | Screen capture with separate logical output regions, including negative origins and integer mixed scales | Normal transforms, scales 1–4 and nonoverlapping regions only; output scale is explicitly passed to grim; other compositors/versions/transforms remain unavailable |
| Peekaboo coordinate-context v1 | Exact CLI `result.data.coordinate_context`, single identified display or window, CoreGraphics Codable bounds and delivered size | `global_display_points`, `top_left`, matching raster and uniform output scale required; unknown context versions and unidentified mosaics remain unavailable; native macOS acceptance remains outstanding |

Bounded platform probes share a two-second budget per bracket within the action deadline. Failed probes leave the capture usable with unavailable geometry. Equality before and after capture is a stability check, not an atomic snapshot: a layout that changes and changes back between probes is undetectable. Grim has no version flag in the qualified build; its helper version stays null, while geometry evidence names the versioned Sway probe and capture explicitly requests its derived scale. No provider path authorizes an image read.

X11 click coordinates must fit signed 16-bit XTest coordinates and the current root extent. Signed i32 syntax remains accepted by the shared request contract, including surrounding whitespace; a platform can reject values it cannot honor. Out-of-root X11 coordinates return `COORDINATES_OUT_OF_RANGE` before input rather than wrapping or clipping to an edge.

Ydotool 0.1.8 uses different arguments from modern releases. Even 1.0.4 implements `--absolute` by a relative reset and subsequent motion, so its arguments are not inherently global desktop coordinates. The adapter queries Debian package identity without invoking an old input helper for help. The retained simple path requires ydotool 1.0.4 at its registered `/usr/bin/ydotool`, Sway 1.7, one scale-1 output at 0,0, an in-bounds target, and the registered ydotool virtual pointer with flat acceleration and speed zero. Unknown versions, unregistered devices, other compositors, negative origins and mixed-scale layouts return `POINTER_MAPPING_UNVERIFIED` before input. These checks do not claim native pointer acceptance; no new origin translation or backend is enabled without observed target effects. Input is never replayed.

## Disposable Linux fixture

`scripts/native-image-fixture/fixture.py` is an opt-in GTK application with known colored targets and visible click/key counts. `qualify.py` drives the real adapter/helpers, decodes target pixels, checks coordinate events and changed target color, and verifies cancellation during a real blocked capture helper. Run it only inside an owned disposable graphics container, with the adapter built from the source being qualified. The output directory must not exist. No host helper installation, privacy grants or user applications are involved.

```sh
python3 scripts/native-image-fixture/qualify.py --session x11 --adapter /owned/coven-desktop-use --output /owned/receipts/x11 --server-pid 1 --owned-disposable-display
python3 scripts/native-image-fixture/qualify.py --session wayland --adapter /owned/coven-desktop-use --output /owned/receipts/wayland-negative --server-pid 8 --output-name HEADLESS-2 --owned-disposable-display
```

Supply the actual owned Xvfb/Sway PID and display environment. Cancellation temporarily stops that dedicated server and resumes it in teardown; never target a shared desktop. Wayland output placement uses setup commands only; capture/input effects are checked through the adapter. Each fixture has a unique title; Wayland focus targets its exact process-owned container ID and verifies both the focused node and seat. A run may report `pointerVerified:false` with explicit unsupported status. A missing keyboard effect retains `verified:false` and exits 1 after completing independent cancellation checks; it does not substitute source assertions or process success for effects. Keep captures out of commits and durable audit; retain sanitized metadata separately.

## Host frame preservation

The gateway fixture includes a synthetic 3200×1800 image with four quadrant landmarks. The actual provider request must contain the pinned host's 1200×675 JPEG with the normalized landmarks intact, while observation text retains the source extent. This checks scale, cropping, reflection and rotation for that conversion, not arbitrary model perception or every host. Existing 32×24 PNG/JPEG exact-byte checks remain separate.

OpenClaw 2026.4.26 needs an image backend to resize the fixture; without optional Sharp, its actual sanitizer omits the large image. Gateway CI stages isolated OpenClaw 2026.4.26 plus Sharp 0.34.5 with install scripts disabled and explicitly selects `sharp`. Dev-only `jpeg-js` 0.4.4 verifies received JPEG landmarks and is not a plugin runtime dependency. macOS SIPS can be qualified separately with `OPENCLAW_IMAGE_BACKEND=sips`. Packed gateway, hosted CI and native desktop effects remain separate evidence.

## Source evidence

Peekaboo is pinned to [69764083 coordinate model](https://github.com/openclaw/Peekaboo/blob/69764083b16397845dc68b5c0ddb4f674290ae70/Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/Core/Protocols/ScreenCaptureServiceProtocol.swift#L388) and [CLI output](https://github.com/openclaw/Peekaboo/blob/69764083b16397845dc68b5c0ddb4f674290ae70/Apps/CLI/Sources/PeekabooCLI/Commands/AI/SeeCommand%2BOutput.swift). A local CoreGraphics Codable probe confirms CGRect/CGSize array representation; this is source/serialization evidence, not an installed helper receipt.

[Grim 1.4.0](https://github.com/emersion/grim/blob/e2cb2d12790fb4d5e91ddc20c3dbe896b00f70ee/main.c) establishes the explicit output-scale and logical-output capture interface. [Ydotool 1.0.4 mousemove](https://github.com/ReimuNotMoe/ydotool/blob/57ba7d0af525e82da2de0e275d169477f293b197/Client/tool_mousemove.c) establishes reset-relative semantics and acceleration requirements. Runtime capture, registration and observed effects remain separate acceptance evidence.
