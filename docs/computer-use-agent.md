# Computer Use Agent

This package implements the OpenCoven `computer-use` boundary for OpenClaw. It
keeps machine control out of OpenClaw core and exposes it through an external
plugin plus the `coven-desktop-use` adapter.

## Implementation Map

- `src/plugin-tool.ts`: OpenClaw `computer_use` tool, legacy `desktop_use` alias,
  action adapters, timeouts, structured results, and audit writes.
- `src/computer-use-policy.ts`: risk classification, approval decisions, unsafe
  shell blocks, workspace checks, and redaction.
- `src/computer-use-audit.ts`: append-only JSONL audit events with redacted
  params and result hashes.
- `src/computer-use-agent.ts`: dedicated agent identity, workspace, memory, auth,
  tool policy, health, logs, and Control UI descriptor.
- `agents/computer-use/IDENTITY.md`: packaged identity for the dedicated agent.
- `agents/computer-use/openclaw-agent.json`: install/config template for the
  dedicated agent boundary.
- `src/main.rs`: native adapter that delegates macOS observation and input to
  Peekaboo with `--json --no-remote`.

`OpenCoven/open-side` was not changed for this slice. It is the operator shell;
the trust boundary already belongs in this adapter/plugin package. The plugin
does provide a Control UI descriptor that OpenSide or OpenClaw Control UI can
consume for the panel state.

## Install Shape

Build or install the adapter:

```bash
cargo build
# or, once published:
cargo install --git https://github.com/OpenCoven/desktop-use coven-desktop-use
```

Install the plugin locally while developing:

```bash
openclaw plugins install . --force
```

Point the gateway at a local adapter binary when needed:

```bash
export COVEN_DESKTOP_USE_BIN=/absolute/path/to/coven-desktop-use
```

Create or update the dedicated agent using the packaged identity:

```bash
openclaw agents add computer-use \
  --workspace ~/.openclaw/workspace/computer-use \
  --agent-dir ~/.openclaw/agents/computer-use/agent
```

Copy or sync `agents/computer-use/IDENTITY.md` into that agent directory as
`IDENTITY.md`, and mirror `agents/computer-use/openclaw-agent.json` into the
agent or local OpenClaw config if the CLI does not yet import templates.

Auth is agent-scoped by policy. The agent may inherit the main OAuth profile,
but OAuth refresh tokens must stay in the owning profile store and must not be
copied into the agent directory. If a separate auth order is needed, bind it to
the agent rather than widening the default agent.

## Tool Boundary

The plugin registers `computer_use` and a legacy `desktop_use` alias. New config
should allow only `computer_use` for this agent:

```json
{
  "tools": {
    "allow": ["computer_use"],
    "deny": ["exec", "bash", "shell", "apply_patch"]
  }
}
```

Supported actions:

- Observation and control: `health`, `stop`, `doctor`, `inspect`, `screenshot`
- Desktop input: `click`, `type-text`, `keypress`, `scroll`, `focus`
- Local app/browser: `app-launch`, `browser-open`
- Scoped host actions: `shell`, `file-list`, `file-read`, `file-write`
- Clipboard: `clipboard-read`, `clipboard-write`

Shell execution uses `execFile` with argv, not shell interpolation. Workspace
reads and read-only shell commands can run without approval. Writes, external
network-visible commands, package installs, clipboard access, app launch, remote
URLs, and desktop input require explicit OpenClaw approval. Attempts to reset or
bypass macOS security boundaries, use privilege helpers, or run obviously
destructive commands are blocked.

## macOS Permissions

The adapter relies on normal macOS TCC prompts. Do not bypass, reset, or
pre-authorize privacy databases.

Required grants:

- System Settings > Privacy & Security > Screen Recording
- System Settings > Privacy & Security > Accessibility

Grant access to the exact binaries in use, usually:

- `coven-desktop-use`
- `peekaboo`
- the terminal app or service that launched OpenClaw
- `node` or `openclaw` if that process invokes the adapter

After changing grants, restart the launcher or OpenClaw Gateway and rerun:

```bash
coven-desktop-use doctor
```

## Approval And Audit

Policy decisions have one of three statuses: `allow`, `needsApproval`, or
`blocked`. Approval prompts include risk, target, exact redacted input when
available, and rollback notes for writes.

Audit logs are append-only JSONL:

```text
~/.openclaw/agents/computer-use/audit/computer-use.jsonl
```

Each event includes timestamp, agent id, session key, tool call id, action,
target, risk, approval id when present, redacted params, result status, and a
result hash. Raw screenshot data, raw clipboard content, typed text, file-write
content, tokens, cookies, and credentials are not written to durable logs.

## Control UI State

The plugin registers `computer-use-panel` when the host supports Control UI
descriptors. The descriptor schema covers:

- `health`
- `permissions`
- `activeTarget`
- `latestObservation`
- `pendingApprovals`
- `recentActions`
- `errors`
- `repairHints`
- `controls`

This is a state contract for the dedicated agent panel; it is intentionally not
a broad grant to the default agent.

## Reliability

Actions have bounded timeouts. `stop` is an auditable local control action that
acknowledges cancellation and returns the agent to idle when no background
runner is retained. Observation and health adapter calls retry once
only for transient runtime failures such as timeouts, stale observations, busy
backends, or reset connections. Interactive, destructive, clipboard, shell, and
filesystem actions do not retry internally.

Every action returns a structured status (`success`, `needsApproval`, `blocked`,
`unsupported`, or `error`) with enough repair context for the gateway or Control
UI to show the next step.

## Verification

Focused checks:

```bash
pnpm run typecheck
pnpm run test:ts
pnpm run check:plugin-runtime-imports
cargo test
pnpm run check
```

Real local health check:

```bash
cargo run -- doctor
```

Plugin-level health check after install:

```json
{
  "tool": "computer_use",
  "args": {
    "action": "health"
  }
}
```
