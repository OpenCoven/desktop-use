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
