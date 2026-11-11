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
- `src/host-actions.ts`, `src/file-actions.ts`, `src/process-runner.ts`: plugin-side
  clipboard/browser/app-launch planning, bounded file actions, and the owned
  helper process runner.
- `src/main.rs`: native adapter that delegates macOS observation and input to
  Peekaboo with `--json --no-remote`, and Linux observation and input to the
  per-session X11/Wayland helpers.
- `src/linux_capabilities.rs`, `src/process.rs`: Linux capability reporting and
  the adapter's bounded helper process groups.

The names map to layers: `coven-desktop-use` is the GUI-only adapter binary
(`doctor`, `inspect`, `screenshot`, `click`, `type-text`, `keypress`, `scroll`,
`focus`); `computer_use` is the agent tool that wraps it with policy, approval,
audit, and the host actions listed below. Repair hints and verification steps
returned by the plugin always name `computer_use`; hints printed by the binary
name `coven-desktop-use`.

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

The plugin registers `computer_use` and a legacy `desktop_use` alias. The alias
is the same tool under another name: same schema, policy, approval hook, and
audit path. It is registered as optional and exists only so older configs keep
working. New config should allow only `computer_use` for this agent:

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

Shell execution uses argv without shell interpolation. Workspace reads can run without approval. General shell execution requires explicit approval because effects cannot be inferred safely from command names. Writes, external network-visible commands, package installs, clipboard access, app launch, remote URLs, and desktop input require explicit OpenClaw approval. Attempts to reset or bypass macOS security boundaries, use privilege helpers, or run obviously destructive commands are blocked.

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

The plugin offers `computer-use-panel` through the optional host `registerControlUiDescriptor` API. This is integration metadata, not a running panel, state store, subscription, or gateway RPC. Hosts without that API do not get a panel merely by loading the plugin. Rendering and connecting the panel are host responsibilities.

Only two plugin controls are advertised. The descriptor's `actions.stop` maps to `computer_use action=stop`; `actions.runHealthCheck` maps to `computer_use action=health`. The host enables them only when it can invoke that tool under the current agent policy and gateway authentication. `requiredScopes: ["operator.read"]` describes reading panel state, not permission to invoke controls. Tool calls retain their normal authorization. Stop requests cancellation for active calls in the same agent/session/workspace; it does not pause future work, revoke approvals, or clear a retained target. Those operations belong to a host that implements them and are not advertised as plugin controls.

The schema describes host-rendered state. `stateSources` identifies the producer and availability of every field; it does not imply that the plugin emits a combined state object. Hosts translate available results into the schema and leave unavailable fields absent instead of inventing successful or empty state.

| Field | Producer and source | Availability |
| --- | --- | --- |
| `health` | Plugin health action result; host renders state, check time, adapter, and gateway context | After an explicit health call; a missing backend remains a failed health result |
| `permissions` | Plugin doctor result and `permissionFlow`; host projects individual permission states | After doctor/health; missing backend or protocol evidence remains unavailable/unverified |
| `activeTarget` | Host-selected app/window/URL | Only if the host tracks a target; the plugin has no active-target store |
| `latestObservation` | Host projection of inspect/screenshot results | After an observation; the plugin does not retain observations |
| `pendingApprovals` | Host subscription to gateway plugin-approval events or authenticated pending-request lookup | Only with gateway approval integration; the plugin does not own the approval queue |
| `recentActions` | Host projection of tool results or redacted JSONL action audits | Only if the host reads those results or records; audit records are not a full input history |
| `errors` | Host projection of structured failed action results | After a failed call; the plugin does not retain an error store |
| `repairHints` | Plugin health `repairHints` and `permissionFlow` | After an explicit health call |
| `controls` | Host combines descriptor action mappings with current tool availability and policy | Only when the host can invoke the mapped tool; unsupported operations remain absent |

## Reliability

Actions have bounded timeouts. `stop` is an auditable local control action that
requests cancellation of active calls in the same agent/session/workspace. It
reports `cancelling` while those calls settle and `idle` when none were active;
it does not undo completed effects or revoke approvals. Observation and health adapter calls retry once
only for transient runtime failures such as timeouts, stale observations, busy
backends, or reset connections. Interactive, destructive, clipboard, shell, and
filesystem actions do not retry internally.

Every action returns a structured status (`success`, `needsApproval`, `blocked`,
`unsupported`, `error`, `cancelled`, or `timeout`) with enough repair context for the gateway or Control
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
