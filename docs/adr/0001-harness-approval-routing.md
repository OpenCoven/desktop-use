# ADR 0001: Route MCP approvals to an operator-launched approver while a harness owns the terminal

- Status: Proposed. Awaiting owner sign-off on #33; nothing below is implemented.
- Date: 2026-11-14
- Issue: #33 (part of #32)
- Baseline: main `155c30a1a0d0ee25ffaf94b45728eb1deebe59bc`

## Context

The MCP connector executes gated `computer_use` effects only after a trusted approval provider answers. The only provider shipped is the reference approval host (`examples/approval-host/`), which is itself the stdio server command: it spawns the connector, passes it a broker secret on descriptor 3, and prompts the operator on `/dev/tty`. When a coding harness launches that command, `/dev/tty` belongs to the harness.

The #33 reproduction tested this with real harness binaries on macOS, using disposable config homes, a local deterministic model endpoint, and no live credentials:

| Harness | MCP child and the harness terminal | A blocking `/dev/tty` read | Gated `file-write` outcome |
|---|---|---|---|
| Claude Code 2.1.325, interactive TUI | Same terminal, harness foreground process group | Waits for keystrokes (`S+`), competing with the TUI | Review drawn into the TUI and overdrawn by its spinner. The scripted operator's `deny` was consumed by the TUI, and approval expired after 60 s (`APPROVAL_EXPIRED`). No effect; one audit line |
| Claude Code 2.1.325, print mode | Same terminal, harness foreground process group | Waits for keystrokes (`S+`) | Review printed into the harness output. `deny` reached the host only because print mode does not read the keyboard (`APPROVAL_DENIED`, no effect) |
| Codex CLI 0.169.0, `exec` | Same terminal, own background process group | `SIGTTIN` stops the reader and the whole MCP process group (`T`) | A decision read would freeze the host and the connector it spawned |
| GitHub Copilot CLI 1.0.111 | Not observed: the CLI requires GitHub authentication before starting MCP servers | n/a | Blocked (owner-authorized test token needed) |
| Coven Code 0.9.0 | Not observed: print mode did not start an MCP server from `settings.json` or `--mcp-config` | n/a | Blocked (recipe unknown) |

Two further observations shape the decision:

- Claude Code's default permission mode is now **auto**, where Claude decides its own tool calls. With auto mode on and the tool pre-allowed in the harness, desktop approval was still requested. Harness permission is not desktop approval, and that part already holds.
- Claude Code initially dropped the tool because of a schema incompatibility, tracked separately in #41. The reproduction used an uncommitted build with only that guard removed.

## Decision drivers

These must all hold (from `docs/mcp.md` and #32):

- The model can never approve, and approval never travels in tool arguments or MCP client metadata.
- The broker's challenge binding, nonce/HMAC, expiry, replay register and full-display limits stay intact.
- The secret never touches disk, arguments, environment or logs.
- The approval surface must work while any Tier A harness owns its terminal, in TUI and non-interactive modes.
- Harness tool-permission prompts and auto-approve modes never satisfy desktop approval.
- The adapter stays thin: host products own approval UX; this repository supplies the contract and one reference path.

## Options considered

### A. Operator-launched approver with a harness attach relay (recommended)

The operator starts the approver in its own terminal or window: for example `coven-desktop-use-approver --config <trusted config>`. The approver:

- creates a private `0700` directory and a `0600` attach socket;
- for each attach connection, spawns a fresh connector child with the existing broker socket and descriptor-3 secret, exactly as the reference host does today;
- relays MCP bytes between the attach connection and that child.

The harness's MCP command is a pure byte relay, for example `coven-desktop-use-mcp attach --socket <path>`. It holds no secret and no authority. Prompts render in the approver's own terminal, which no harness owns.

- **Trust:**
  - The secret stays in memory, passed by descriptor exactly as today.
  - A model that connects to the attach socket itself gains only MCP access, which it already has. It cannot answer a challenge.
  - Harness auto-approve modes only let the harness call the tool; desktop approval still happens in the approver.
- **Fit:**
  - Works for every harness that can launch a stdio command, regardless of how it handles the child's terminal or process group.
  - Reuses the broker protocol and terminal UI unchanged.
  - Coven, Cave or OpenSide can later replace the terminal approver behind the same broker protocol (option D).
- **Lifecycle:**
  - Harness exit closes the relay and then the connector's stdin, so the existing EOF cleanup runs.
  - Approver exit closes every relay, and harnesses see the server close.
  - Same-scope Stop is unchanged. Each attach gets a distinct session suffix, so Stop and audit stay scoped per harness session.
- **Costs:**
  - The operator must start the approver before the harness, and a missing approver must fail visibly.
  - The current `busy` behavior returns `unavailable` for a concurrent second prompt; a bounded queue should replace it.

### B. MCP elicitation

The connector asks the harness to collect the decision through MCP elicitation.

- **Trust:** the answer arrives through the harness process that also runs the model loop. The connector cannot verify that a human answered rather than the harness, an auto-accept setting, or a headless mode. Support and rendering also vary by harness. Rejected as approval authority. It may be used later only as a notice pointing at the approver ("approval pending in your approver").

### C. OS-native dialog spawned by the connector

The connector opens an `osascript`, `zenity` or `kdialog` dialog.

- **Trust:** the dialog lives on the same desktop the tool controls. On macOS, the computer-use setup grants Accessibility to the launching terminal, so any unsandboxed same-user command from that harness can script the dialog through System Events. The tool's own click and type actions could also target it.
- **Fit:** there is no reliable dialog on headless or Wayland sessions without extra helpers.
- Rejected as the default. It could be reconsidered only with a separately signed helper whose dialog is not scriptable by the launching terminal.

### D. Coven, Cave or OpenSide approval panel

A separate product app acts as the approver.

- This is the best long-term operator experience, but out of this repository's scope.
- Option A's attach relay and the existing broker protocol are the integration point. A panel becomes another approver host without changing the connector.

### E. Keep the reference host as the harness MCP command (status quo)

Rejected. The reproduction shows it collides with Claude Code's TUI, freezes under Codex, and fails closed or worse.

## Decision

Adopt option A as the reference path for harnesses, keep option D as the product direction behind the same broker protocol, and reject options B, C and E as approval authority.

## Residual risk that the docs must state

A same-user process with unrestricted command execution is outside this boundary, as `docs/mcp.md` already says. Harnesses make that concrete:

- An unsandboxed shell tool running in a bypass mode (for example `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox` or `--allow-all`) runs as the operator.
- If the launching terminal holds Screen Recording and Accessibility, such a shell can read and answer an on-screen approval in another window.

Desktop approval is still requested in these modes, but its integrity cannot be guaranteed. The harness docs (#37) must therefore:

- describe L3 as holding only when the harness's own command execution is approval-gated or sandboxed away from the approver;
- recommend granting macOS privacy permissions to the narrowest launcher possible.

## Implementation plan after sign-off

1. **Approver and relay:**
   - Add the approver entry point and the attach relay as new compiled entries.
   - Move the reference host's spawn logic into the approver, so one code path owns the descriptor-3 secret.
2. **Lifecycle:**
   - Give each attach connection a fresh connector and a distinct session suffix.
   - Queue concurrent reviews with a bound, and fail visibly when the approver is absent or the queue is full.
3. **Tests:** packed tests for the relay (no secret on disk, in arguments or in the environment; EOF cleanup both ways; approver absent; queue full), plus the existing broker negative tests.
4. **Real-harness receipts:** using the #35 runner or the #33 reproduction scripts, under the Claude Code TUI and Codex:
   - allow produces exactly one effect;
   - deny, expiry, cancel, disconnect and a busy queue produce none;
   - auto and bypass modes still require desktop approval.
5. **Docs:** an operator flow per Tier A harness in `docs/mcp.md`, plus the residual-risk text above.

## Consequences

- Harness setups gain a second process the operator must start; recipes in #34 must show both commands.
- The connector, broker protocol and policy are unchanged, so existing SDK, MCP and OpenClaw behavior and tests remain valid.
- The reference host's current "is the stdio command" mode stays available for non-harness MCP clients, but harness docs stop recommending it.
