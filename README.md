# OpenCoven Desktop Use

`coven-desktop-use` is a tiny external desktop-use adapter for OpenClaw and
OpenCoven surfaces.

It keeps platform automation outside OpenClaw core. OpenClaw can register a thin
plugin that calls this binary, while this adapter owns platform-specific backends.

## Status

Dedicated OpenCoven computer-use boundary for OpenClaw:

- macOS: shells to [`peekaboo`](https://peekaboo.boo) with `--json --no-remote`
- Linux (X11): shells to `scrot`/`maim` (capture), `xdotool` (input), `wmctrl` (focus)
- Linux (Wayland): shells to `grim` (capture), `wtype`/`ydotool` (input), `swaymsg` (focus on Sway)
- Windows: returns a clean unsupported JSON response for now
- Session detection uses `XDG_SESSION_TYPE`, with fallback to `WAYLAND_DISPLAY`/`DISPLAY`
- No shell interpolation; uses process argv directly
- Interactive desktop actions require OpenClaw approval and adapter `--confirm`
- Typed text, clipboard text, file-write content, tokens, cookies, and secrets
  are redacted from durable logs
- The OpenClaw plugin registers `computer_use` plus legacy `desktop_use`

## Commands

```bash
coven-desktop-use doctor
coven-desktop-use inspect --mode frontmost
coven-desktop-use screenshot --mode screen --format png
coven-desktop-use click --on B1 --confirm
coven-desktop-use type-text --text "hello" --return --confirm
coven-desktop-use keypress --keys tab,return --confirm
coven-desktop-use scroll --direction down --amount 3 --confirm
coven-desktop-use focus --app TextEdit --confirm
```

All commands print a JSON envelope. The 0.1.0 command names remain as aliases: `permissions -> doctor`, `see -> inspect`, `capture -> screenshot`, `type -> type-text`, and `press -> keypress`. For plugin action inputs, these aliases are deprecated as described below.

## Linux / Ubuntu onboarding

Linux desktop-use shells to per-session helper tools instead of a single
bundled backend. Run the doctor first to see what's installed:

```bash
coven-desktop-use doctor
```

The JSON response includes the detected session (`x11` or `wayland`), a tool
inventory (each tool's path or `found:false`), and a `setupGuide` with the
exact `apt install` line for missing pieces.

Recommended packages by session:

```bash
# X11 (default on Ubuntu 22.04 GNOME with "Login on Xorg" selected,
# or any KDE/X session):
sudo apt install scrot xdotool wmctrl

# Wayland (default on Ubuntu 22.04+ GNOME, Sway, Hyprland, KDE Wayland):
sudo apt install grim wtype ydotool
```

### Wayland capabilities and fallbacks

Doctor reports per-action states (`available`, `degraded`, `unsupported`, or `unverified`) and `runtimeVerified:false`. Available means the required executable/protocol was found; it is not desktop acceptance. When installed, `wayland-info` probes the compositor registry within two seconds of the shared action deadline. A missing or failed probe leaves protocols unverified. Installing a helper alone does not prove compositor support, ydotoold access, uinput permissions, or a successful desktop action.

- `wtype` needs `zwp_virtual_keyboard_manager_v1`; an advertised registry without it rules out wtype. Without a successful registry probe, protocol support remains unverified regardless of desktop name. A verified wtype provider is preferred; otherwise installed ydotool is preferred over an unverified wtype provider. Input is never automatically resent through a second provider after failure.
- `ydotool` needs a running ydotoold and working uinput access. Typing is restricted to ASCII and depends on the active keyboard layout; Unicode needs wtype. Literal backslash escapes are disabled. Common keys/chords use evdev keycodes, and unsupported keys are rejected before any input. Do not treat installed-tool inventory as proof of daemon permissions.
- Scroll uses `ydotool mousemove --wheel` when ydotool is installed. Otherwise wtype sends page/arrow keys and returns an explicit degraded result; amount counts key presses in that fallback. A failed wheel request is not replayed as page keys.
- `grim` needs `zwlr_screencopy_manager_v1` or, with compatible grim versions, the `ext_image_copy_capture_manager_v1` and `ext_output_image_capture_source_manager_v1` pair. The ext-only path remains unverified until the installed helper succeeds. Window/frontmost capture is unsupported and never silently broadened to the full desktop; request `mode:screen` explicitly. GNOME/KDE capture is unsupported when the registry does not advertise the protocol, or unverified when a probe is unavailable.
- Focus supports Sway only, with SWAYSOCK and swaymsg. App, title, and numeric id selectors are combined. App ids are exact literal patterns; title fragments are escaped literal patterns, and the JSON IPC response must report success. Other compositor focus is unsupported.

Linux inspect returns a screenshot without AT-SPI element ids. Input uses coordinates or the current focus. App/window/screen/element selectors on Linux actions that cannot honor them are rejected before any helper runs; focus remains a separate approved action. X11 active-window capture uses scrot, or maim with a successful numeric xdotool lookup. Failed lookup never captures the entire screen. Screenshot filenames have explicit argv option boundaries.

### Linux clipboard and launch integrations

The plugin supports clipboard reads/writes through wl-paste/wl-copy in Wayland, or xclip with xsel as an X11 fallback. Clipboard actions retain the existing explicit approval gate, write text through stdin, and return contents only with includeText. Wayland does not silently substitute the XWayland clipboard. Missing tools or a headless session produce a clear unsupported response; compositor/selection access failures produce bounded process errors.

Linux browser-open uses installed xdg-open for absolute HTTP(S) URLs without embedded credentials. App-launch uses installed gtk-launch with an installed desktop entry id such as org.example.App.desktop. Both retain the existing approval policy. A successful launch helper acknowledges handoff; it does not prove a page or window appeared.

Clipboard writers and launchers deliberately hand ownership to a clipboard selection server or launched app on success. Those processes can outlive the action and are not killed by a later stop. A timeout, cancellation, or failed handoff still terminates the owned launcher group. All integrations use the documented helper bounds and output limits. No system helpers are installed automatically.


## macOS onboarding

Desktop inspection and interaction require two macOS privacy grants because the
adapter captures the screen and drives accessibility APIs through Peekaboo.

Run the doctor first:

```bash
coven-desktop-use doctor
```

If permissions are missing, the JSON output includes a `permissionGuide` with
the exact Settings panes and binaries to approve. The usual paths are:

- System Settings → Privacy & Security → Screen Recording
- System Settings → Privacy & Security → Accessibility

Grant access only to the local binaries you intentionally installed, typically:

- the adapter binary, for example `~/.cargo/bin/coven-desktop-use`
- the Peekaboo backend binary, for example `/opt/homebrew/bin/peekaboo`

After granting permissions, quit/restart the app or service that launched the
tool, or restart the OpenClaw Gateway, then verify:

```bash
coven-desktop-use doctor
```

`inspect` and `screenshot` should be used before interactive actions. Actions
that click, type, press keys, scroll, or focus windows still require explicit
confirmation via `--confirm` at the adapter layer and `confirm: true` through the
OpenClaw plugin.

## Build

```bash
cargo build
cargo test
```

## OpenClaw integration

The OpenClaw plugin shape is deliberately small:

```text
OpenClaw computer_use tool -> execFile("coven-desktop-use", args) -> platform backend
```

OpenClaw owns gateway auth, tool policy, approvals, and Control UI state. This
package owns the dedicated computer-use agent contract, redacted audit events,
and desktop backends.

## OpenClaw plugin package

This repo also ships an external OpenClaw tool plugin package under the OpenCoven scope:

```text
@opencoven/openclaw-desktop-use
```

The plugin registers the `computer_use` agent tool and a deprecated `desktop_use` alias. New configurations should allow only `computer_use` for the dedicated agent. See [docs/computer-use-agent.md](docs/computer-use-agent.md) for the agent identity, approval model, audit contract, and verification checklist.

### Deprecated plugin inputs

The schema prefers 18 canonical actions and retains five deprecated 0.1.0 action aliases in deprecated compatibility branches and the overall 23-value enum. These aliases remain visible to hosts and normalize on input for this compatibility release. Migrate these names before their targeted removal in 0.2.0:

| Deprecated input | Replacement |
| --- | --- |
| Tool `desktop_use` | `computer_use` |
| Action `permissions` | `doctor` |
| Action `see` | `inspect` |
| Action `capture` | `screenshot` |
| Action `type` | `type-text` |
| Action `press` | `keypress` |
| `clipboard-write` field `text` | `clipboardText` |

Use `computer_use` with `{ "action": "clipboard-write", "clipboardText": "hello" }` for clipboard writes. The `text` field remains the canonical input for `type-text`. If both clipboard fields are supplied, `clipboardText` keeps precedence and supplying `text` still produces a notice.

Legacy plugin inputs add a `deprecation` string to result details and the JSON text response, for example `"deprecation": "permissions is deprecated; use doctor instead."`. Multiple notices are combined in that string. Canonical calls omit the field. Notices preserve action status, approval decisions, and redacted audit behavior, including failures. Malformed requests still fail validation before execution. The `desktop_use` tool remains registered and listed in `openclaw.plugin.json` for this release.

### Installation

Install the adapter binary from this repo:

```bash
cargo install --git https://github.com/OpenCoven/desktop-use coven-desktop-use
```

By default the plugin expects `coven-desktop-use` to be on `PATH`; for local
development, point OpenClaw at a built adapter binary:

```bash
COVEN_DESKTOP_USE_BIN=/path/to/coven-desktop-use
```

Local plugin checks:

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run test:ts
pnpm run check:plugin-runtime-imports
cargo test
pnpm run check
```

Intended install shape once published:

```bash
openclaw plugins install @opencoven/openclaw-desktop-use
```

Local development install:

```bash
openclaw plugins install . --force
```

GitHub Actions runs `pnpm run check` on macOS and Linux for pull requests and pushes to `main`. These checks cover the adapter contract and policy. Interactive desktop acceptance still requires a graphical session and its permissions.

The plugin validates request types, supported actions, enum values, integer bounds, byte limits, and NUL bytes before approval hooks and execution. A successful adapter process exit does not imply a successful desktop action: the plugin preserves errors, unsupported results, and confirmation requirements from the JSON envelope. Observation failures may be retried once; interactive actions are never automatically retried.

Execution failures return structured errors and reach the redacted audit path. If an audit write fails, the response includes `audit: { written: false, code: "AUDIT_WRITE_FAILED" }` while preserving the action outcome. An action may already have completed; inspect its outcome before deciding whether to repeat it. Malformed requests are rejected before policy evaluation and are not persisted in the action audit.

Real adapter health check:

```bash
cargo run -- doctor
```

## Execution bounds, stop, and privacy

The CLI gives each action a cumulative 30-second helper deadline, including every step of a sequence. `--timeout-ms` accepts an integer from 1000 to 120000. The plugin defaults to 30 seconds, or 45 seconds for inspect/screenshot, and shares that budget across its single observation retry. Timed-out and cancelled work is never retried automatically. Each helper has a 1 MiB combined output limit in the CLI; plugin host helpers have a 64,000-byte combined limit, and the adapter JSON has a 10 MiB limit.

On supported Unix hosts, owned helpers run in a separate process group. The CLI kills and reaps that group on completion, deadline, or SIGTERM/SIGINT cancellation. The plugin requests TERM and escalates to KILL after a 250 ms cleanup grace, so an uncooperative helper cannot hold the call open indefinitely. Result codes distinguish `ETIMEDOUT`, `CANCELLED`, missing dependencies, malformed output, and backend rejection. Multi-step actions stop at the first failure and report completed steps and the failing step; completed input is not rolled back.

Plugin `stop` requests cancellation of active calls in the same agent/session/workspace, including calls from another instance of the tool in this process. It returns `cancelling` while those calls settle. Calls made without a session key form their own scope and never match a named session. The host may also supply an AbortSignal as the third execute argument. Stop does not revoke future approvals, stop other gateway processes, undo completed effects, or interrupt a filesystem syscall already in progress. Injected adapter runners must honor the AbortSignal; the built-in runner owns and terminates its helper processes.

File targets are resolved through symlinks before approval classification; relative traversal and symlink escapes require approval for the canonical external target. File and clipboard contents are returned only with `includeText:true`. These checks prevent static path escapes; they are not an OS filesystem sandbox against another process concurrently replacing directories or symlinks. Use a workspace without hostile concurrent writers.

Raw failing-helper stdout, stderr, and argv are withheld from process diagnostics. Durable audit events summarize free-form strings, including paths, titles, URLs, argv, and reasons, and never store file/clipboard/text contents. Audit persistence errors add `audit: { written: false, code: "AUDIT_WRITE_FAILED" }` while preserving the operation outcome, since the operation may already have completed. Do not blindly retry an action after an audit failure.

Review hardening validates required action arguments and own request properties before approval. Shell and health exceptions share safe error handling; legacy and current Peekaboo envelopes are decoded before outcome classification and retry.

Explicit screenshot/inspect destinations, including aliases, require write approval because a helper can replace the chosen file. Default captures use adapter-owned temporary destinations. General shell execution always requires runtime approval; command names are not a reliable proof of read-only effects. Absolute executable paths receive the same risk classification as their basenames.

Text file reads require regular files and are capped at 1 MiB with incremental cancellation/deadline checks. Directory lists stop after 500 entries. Writes stage private content in the destination directory and check cancellation before the atomic publish; overwrite:false uses an atomic no-replace link. FIFOs and other special files are rejected. A filesystem syscall already in progress cannot be interrupted, and an already published change is not rolled back by Stop.

Linux captures are written into a fresh private staging directory beside the destination, validated as a new nonempty regular file, and atomically published only after success and a cancellation/deadline check. A stale existing destination cannot satisfy capture success. X11 focus resolves all supplied selectors together through wmctrl inventory and rejects ambiguous matches; xdotool fallback accepts only a single selector. Sway combines escaped literal criteria rather than treating identifiers as caller-provided regex.

The approval hook resolves filesystem targets using the authenticated tool-factory workspace before showing the prompt and carries the canonical path into execution. If that path resolves elsewhere after approval, execution clears confirmation and requires a new approval. Missing workspace context fails visibly. Missing path ancestors use platform-aware relative paths, including Windows drive roots; Windows graphical support remains unimplemented.

Timeout/cancellation cleanup reserves up to 250 ms for the adapter to report completedSteps, totalSteps, failedStep, and partial. Only validated counters are retained; raw diagnostics are withheld. When no valid report is available, progressUnknown:true makes that uncertainty explicit. Where the configured budget permits, the Rust deadline expires 100 ms before the host timer. A timeout option without a value is rejected before dispatch.

Screenshot encoding follows --format independently of the destination suffix. A ydotool-only input request skips the optional Wayland registry probe because the wtype protocol cannot affect its provider choice.
