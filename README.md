# OpenCoven Desktop Use

`coven-desktop-use` is a tiny external desktop-use adapter for OpenClaw and
OpenCoven surfaces.

It keeps platform automation outside OpenClaw core. OpenClaw can register a thin
plugin that calls this binary, while this adapter owns platform-specific backends.

## Status

Proof of concept:

- macOS: shells to [`peekaboo`](https://peekaboo.boo) with `--json --no-remote`
- Linux/Windows: returns a clean unsupported JSON response for now
- No shell interpolation; uses process argv directly
- Interactive actions require `--confirm`
- Typed text is redacted from command echoes and type stdout

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

All commands print a JSON envelope. The 0.1.0 command names remain as aliases:
`permissions -> doctor`, `see -> inspect`, `capture -> screenshot`,
`type -> type-text`, and `press -> keypress`.

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

The intended OpenClaw plugin shape is deliberately small:

```text
OpenClaw desktop_use tool → execFile("coven-desktop-use", args) → platform backend
```

OpenClaw owns tool policy and approvals. This adapter owns desktop backends.

## OpenClaw plugin package

This repo also ships an external OpenClaw tool plugin package under the OpenCoven scope:

```text
@opencoven/openclaw-desktop-use
```

The plugin registers the `desktop_use` agent tool and delegates all platform work
to the `coven-desktop-use` adapter binary.

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
cargo test
```

Intended install shape once published:

```bash
openclaw plugins install @opencoven/openclaw-desktop-use
```
