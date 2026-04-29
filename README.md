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
coven-desktop-use permissions
coven-desktop-use see --mode frontmost
coven-desktop-use capture --mode screen --format png
coven-desktop-use click --on B1 --confirm
coven-desktop-use type --text "hello" --return --confirm
coven-desktop-use press --keys tab,return --confirm
coven-desktop-use scroll --direction down --amount 3 --confirm
coven-desktop-use focus --app TextEdit --confirm
```

All commands print a JSON envelope.

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
to the `coven-desktop-use` adapter binary. By default it expects
`coven-desktop-use` to be on `PATH`; for local development, point OpenClaw at a
built adapter binary:

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
