# Local MCP and trusted approval host

The MCP connector maps `computer_use` to the host-neutral `DesktopClient`, preserving all 18 canonical action families, shared validation, image receipts, policy, audit and cancellation. It serves local stdio only. Model requests cannot supply `confirm`, workspace or principal identity, approval decisions, secrets or broker configuration. The only listed tool is `computer_use`. Capabilities identify the consumer as `mcp`; installed helpers and protocol success do not establish desktop acceptance.

The connector consumes the public execution v1 request and structured-result schemas described in [the execution contract and version policy](desktop-client.md#execution-contract-and-version-policy). Its negotiated MCP wire revision is independent of that desktop contract. Both supported wire revisions preserve the SDK's `content` and map its `details` to `structuredContent`.

## Trusted startup

Create an absolute workspace and a separate, existing state directory owned by the current OS user with mode `0700`. Supply an absolute configuration filename owned by that user and not writable by group or others. The connector requires an absolute adapter executable path and principal identity; it does not derive authority from MCP client metadata. The audit file is opened without following symlinks, requires mode `0600` and one link, and cannot silently fall back to unaudited startup. Never put the private state directory inside a model-writable workspace.

```json
{
  "workspaceDir": "/absolute/workspace",
  "stateDir": "/absolute/private-state",
  "principalId": "local-operator",
  "sessionId": "local-session",
  "adapterPath": "/absolute/bin/coven-desktop-use"
}
```

Omitting `actionProfile` chooses `observation-only`. A trusted host can explicitly set `"actionProfile": "full"`; this broadens eligibility and still requires separate approval for gated effects. `approvalTimeoutMs` is a trusted integer from 1 through 300000, defaults to 300000, and is separate from the action timeout.

Install the exact local candidate tarball as described in [the client guide](desktop-client.md#local-candidate-consumption), then run `./node_modules/.bin/coven-desktop-use-mcp --config /absolute/config.json`. Run `./node_modules/.bin/coven-desktop-use-mcp --help` for startup syntax; help uses stderr so stdout remains protocol-only. This candidate is unpublished; the published npm `0.1.3` artifact does not contain these SDK/MCP exports. With no broker, observations remain usable and gated operations return an explicit `needsApproval` result with no effect. Stdout contains only MCP messages; sanitized diagnostics use stderr.

## Separate reference host

Run `node node_modules/@opencoven/openclaw-desktop-use/dist/examples/approval-host/main.js --config /absolute/config.json` as the stdio server command in a local MCP client. This separately launched application creates a short private `/tmp/cdu-*` directory (avoiding Unix socket pathname limits), starts its Unix socket broker, generates an ephemeral secret, and launches the MCP child with that secret through inherited descriptor 3. The secret is never placed in arguments, environment variables, model-visible messages or logs. The host removes its owned socket/directory when the child exits. It does not open a TCP listener. Do not use it as a coding harness's MCP command: a harness owns that terminal. Use the [harness approver](#harness-approver) instead.

The reference host opens its controlling terminal independently of MCP stdin/stdout. Each prompt displays the entire canonical target, every effect parameter, policy, scope, workspace and expiry. Text is JSON-escaped, including non-ASCII characters, so terminal controls and directional formatting cannot obscure the reviewed operation. Enter `allow REVIEWCODE`, `deny REVIEWCODE` or `cancel REVIEWCODE`, using the fresh visible code in that prompt. A delayed decision from a previous review cannot approve another operation. The code is an operator correlation aid, not an approval credential. Private broker challenge identifiers are never displayed.

A missing terminal, busy prompt, invalid decision, disconnected UI or complete display larger than 16 KiB fails closed. The host does not truncate actionable information or automatically approve. Reviews may contain sensitive input and appear only in the operator terminal; do not record terminal sessions containing private work. Durable action audit continues to use the shared redaction contract.

## Harness approver

Coding harnesses such as Claude Code, Codex and GitHub Copilot CLI own the terminal they run in. A review that a harness-launched process prints on `/dev/tty` competes with the harness UI, or stops the process group when the harness runs it in the background ([ADR 0001](adr/0001-harness-approval-routing.md)). For harnesses, the operator starts the approver in a terminal window of its own, and the harness launches only a relay that holds no secret or authority.

Start the approver first, in the foreground of a terminal that no harness uses: `node node_modules/@opencoven/openclaw-desktop-use/dist/examples/approval-host/approver.js --config /absolute/config.json --attach-socket /absolute/private-dir/attach.sock`. The attach socket's directory must be owned by you with mode `0700`, and its path must be canonical, with no symlinks; on macOS, `/tmp` is a symlink to `/private/tmp`. If the final directory is missing, the approver creates it with mode `0700`, and removes it again if the path is then rejected. Keep the path short, because Unix sockets allow about 104 bytes on macOS. At startup the approver validates the trusted configuration and audit state, then refuses to start in any of these cases: it is not in the foreground of a terminal of its own (for example, started with `&`), another approver is live on the socket, or the path holds anything other than its own stale socket. It never removes a file that is not a socket. When it is ready, it prints the absolute command and arguments for the harness's MCP server entry.

Configure the harness's stdio MCP server as `/absolute/node_modules/.bin/coven-desktop-use-mcp attach --socket /absolute/private-dir/attach.sock`. A generic stdio entry looks like this; per-harness recipes and qualification are tracked separately:

```json
{
  "mcpServers": {
    "coven-desktop-use": {
      "command": "/absolute/node_modules/.bin/coven-desktop-use-mcp",
      "args": ["attach", "--socket", "/absolute/private-dir/attach.sock"]
    }
  }
}
```

The relay only moves MCP bytes between the harness and the approver. It accepts only a same-user `0600` socket in a `0700` directory. It never carries a secret, configuration or approval decision, and it does not choose the session's identity. If no live approver is listening, or the approver refuses, drops or stops the session, the relay exits with status 1 and writes one fixed line on stderr; the approver terminal says why.

The attach socket does not authenticate its peer. Any process running as the operator that can connect to it gets its own MCP session, with the same configured action profile as an attached harness. That process does not pass through the harness's own tool-permission prompt. Observations such as `health`, `screenshot` and `inspect` need no review. A screenshot can therefore capture whatever is on screen, including the approver window while it shows a review. Gated effects still require the operator's decision in the approver terminal. The operator cannot tell which process opened a given session; the review shows only its session label. Treat the attach socket like the trusted configuration: keep it out of any model-writable workspace. Where a harness sandboxes its own commands, the sandbox must deny connections to the attach socket's directory, as well as access to the approver.

Each attached harness session gets a fresh connector process, launched with the descriptor-3 secret exactly as the reference host does. The connector runs in its own process session, so Ctrl+C and Ctrl+Z in the approver terminal reach only the approver. Because every session has its own connector, one session's Stop cannot reach another session's operations. The approver also labels each session `attach-RUN-N`: `RUN` is random for each approver run, and `N` counts the sessions in that run. The label is appended to the configured `sessionId` as `:attach-RUN-N`, or used alone when the configuration has none. Every review and audit line names it, so they stay attributable to one harness session across restarts. A connector is started only when the harness sends its first bytes, so a liveness probe or an idle connection does not create one.

Reviews from all sessions queue on the one terminal, with at most 8 active or waiting. The terminal says when a review is waiting behind another, and when one is refused because 8 are already pending; a refused review fails closed as `unavailable`. At most 8 sessions may be attached at once, and the approver refuses further attaches with a line in its terminal. The bounded replay register is shared by every session for the approver's lifetime: after 1024 reviews in total, the approver refuses further reviews with a line in its terminal, and must be restarted.

When a harness exits or its relay is lost, that connector's stdin ends, which cancels its pending and active work and writes audit; output the harness can no longer read is discarded. Stopping the approver with Ctrl+C, SIGTERM or SIGHUP cancels every session, ends every relay with the fixed message and removes its sockets. A repeated stop signal does not interrupt that cleanup, and connectors that have not exited after 5 seconds are killed.

Harness tool-permission prompts and auto-approve or bypass modes only let the harness call `computer_use`; the desktop review still happens in the approver terminal.

A same-user process with unrestricted command execution is outside this boundary. An unsandboxed harness shell tool in a bypass mode runs as the operator. Examples of such modes are `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox` and `--allow-all`. If the launching terminal holds Screen Recording and Accessibility, that shell can read and answer an on-screen review in another window. Desktop approval is still requested in these modes, but its integrity cannot be guaranteed. Rely on it only when the harness's own command execution is approval-gated or sandboxed away from the approver, and grant macOS privacy permissions to the narrowest launcher possible.

Conformance tests drive the compiled approver and relay over a real PTY with a fixture adapter. They cover:

- allow, deny, cancel and expiry;
- queued and refused reviews;
- the session bound and silent probes;
- per-session Stop;
- harness EOF, kill, and a harness that stops reading;
- approver shutdown;
- refused startup, including a background start.

They do not qualify any particular harness; real-harness receipts are separate evidence.

## Broker boundary and lifecycle

The provider accepts only an explicitly configured same-user Unix socket in a canonical, nonsymlink directory with mode `0700`, and a socket owned by that user with mode `0600`. It consumes one 32-byte secret encoded as 64 hexadecimal characters plus LF from an inherited descriptor of at least 3; the descriptor closes after consumption and is bounded by a two-second startup deadline. Each request carries a fresh nonce and a direction-separated HMAC over the complete canonical challenge. Responses authenticate the nonce, digest of the complete request (including operation, scope, policy, target and expiry), and decision. The host rejects repeated nonces/operations and refuses additional requests once its bounded replay register fills; restart the host for a fresh session after 1024 reviews.

The private protocol uses one canonical JSON frame plus LF, bounded to 1 MiB. Request sockets remain open while the UI waits so disconnect cancels the prompt; responses require EOF before acceptance. Invalid UTF-8, extra frames, duplicate keys, bad signatures, wrong challenge binding, expiry, EOF and other malformed input never authorize an effect. The provider closes owned sockets on cancellation or shutdown and does not replay inputs. Same-user filesystem and secret possession are the trust boundary; this is not isolation from a hostile process already running with the operator's account privileges.

The official stdio transport bounds inbound MCP messages to 2 MiB. Shared request collection/byte limits and validated image size limits also apply. SDK cancellation and stdin EOF abort pending and active work; same-scope Stop remains available. An already completed effect is not undone by cancellation, and a successful observation or subprocess handoff is not native UI acceptance.

## Tested protocol matrix

| Wire revision | Official 2.4.0 API | Verified behavior |
| --- | --- | --- |
| `2026-07-28` | `serveStdio` and client `versionNegotiation: { mode: { pin: '2026-07-28' } }` | Real discovery/list/call, canonical schema, capabilities, structured content, typed PNG, cancellation and actual separate approval host |
| `2025-11-25` | Same `serveStdio` factory with `legacy: 'serve'`; client `supportedProtocolVersions: ['2025-11-25']` | Real initialize/list/call, canonical schema, capabilities, structured content, typed PNG and compiled separate approval host |
| Unsupported modern revision | Official bridge rejection | Explicit unsupported-version error; no invented latest constant or fallback claim |

The SDK's legacy `LATEST_PROTOCOL_VERSION` and `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` names are not used to infer modern support. The bridge selects the era from the opening exchange. Both `@modelcontextprotocol/server` (runtime) and `@modelcontextprotocol/client` (development conformance client) are pinned to `2.4.0`. AJV compiles the shared bundled schemas at the MCP boundary; MCP dependencies do not enter the OpenClaw or core import graph.

## Embedding without MCP

An application can construct `DesktopClient` directly. It must supply its own trusted identity, workspace and audit sink and own the operator UI. The provider callback is trusted application code, never a model tool. Run the compiled example with `node node_modules/@opencoven/openclaw-desktop-use/dist/examples/embedded-client.js --config /absolute/config.json`; it proposes one `reviewed-example.txt` workspace write and waits for the same explicit terminal decision. This compiled example uses the same terminal UI as the separately launched host:

```ts
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { terminalPrompt } from './approval-host/terminal.js';

const terminal = terminalPrompt();
const client = createDesktopClient({
  workspaceDir: trustedWorkspace,
  scope: { principalId: trustedPrincipal, sessionId: trustedSession },
  adapterPath: trustedAdapter,
  actionPermissions: resolveActionPermissions({ actionProfile: 'full' }),
  auditSink: writePrivateAuditEvent,
  approvalProvider: challenge => terminal.prompt(challenge, challenge.signal),
});
try {
  const result = await client.execute(
    { action: 'file-write', path: 'reviewed.txt', content: 'A reviewed workspace effect.' },
    { callId: 'application-correlation', signal: applicationAbort.signal },
  );
  consumeResult(result);
} finally {
  terminal.close();
}
```

Conformance tests use disposable workspaces, a fixture adapter and explicitly scripted operator decisions over an actual PTY. They establish local wire/UI/provider execution, including an actual approved workspace write, denial, expiry, cancellation, Stop and EOF cleanup. They do not claim human approval, installed-app qualification, release or deployment.

The pinned official SDK bundles an older AJV/fast-uri implementation that dependency-manifest audits do not enumerate. Both the connector and conformance clients inject the supported public `jsonSchemaValidator` option backed by direct AJV 8.20.0 and patched fast-uri 3.1.9, keeping the bundled default provider inactive. The upstream bundle is preserved intact; a clean dependency audit is not a security certification of bundled code or the application.
