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

## Print-only harness recipes

The compiled candidate can print a harness-native server entry and a separate trusted startup configuration template. Node >=22.14.0 must already be installed. The command uses the absolute Node executable running it and this installed candidate's absolute compiled entry; it does not use a shell, `npx` or `tsx` at runtime.

```sh
node node_modules/@opencoven/openclaw-desktop-use/dist/src/mcp/main.js recipe --harness codex
node node_modules/@opencoven/openclaw-desktop-use/dist/src/mcp/main.js recipe --harness claude --config /absolute/private/desktop-use.json --workspace /absolute/workspace --state /absolute/private/state --adapter /absolute/bin/coven-desktop-use
```

The JSON response contains `configuration.snippet`, `configuration.target`, `startupConfig.value`, its suggested permissions, the Node requirement, checked harness version, source links and qualification limits. Copy the native snippet only into the appropriate harness configuration and save `startupConfig.value` at `startupConfig.path` yourself. The outer recipe response is a receipt/template envelope, not a harness configuration file. Defaults are absolute placeholders that must be replaced. No configuration, state, audit, adapter or broker resource is opened by recipe mode, and the command never creates directories, installs packages or changes settings. Invalid recipe arguments produce a fixed stderr reason code with empty stdout.

Create a canonical, same-user private state directory with mode `0700` outside every model-writable workspace, and a same-user regular connector configuration file with mode `0600`. Ensure the absolute workspace and adapter paths exist before starting the connector. Paths with spaces, quotes, backslashes and Unicode are serialized as literal arguments. Control characters and harness interpolation expressions such as `${VAR}`, `{env:VAR}` and `{file:path}` are rejected, so a harness cannot silently substitute another target after parsing the recipe. The Hermes snippet is JSON-compatible YAML, accepted as a complete YAML mapping; merge it structurally into an existing YAML configuration.

All recipes use server key `coven-desktop-use` and retain the default `observation-only` action profile. No recipe enables a harness auto-approve flag or supplies an approval secret. Broadening the trusted action profile still does not authorize gated effects; those require the existing authenticated broker. Approval routing while a harness owns the terminal remains #33. A harness tool-permission dialog is not desktop approval.

### Recipe evidence, checked 14 November 2026

| Harness id | Checked version | Native shape | Source-derived model-visible name | Evidence |
| --- | --- | --- | --- | --- |
| `claude` | 2.1.325 | `.mcp.json`: `mcpServers` | `mcp__coven-desktop-use__computer_use` | Installed version/help and [official MCP/config and naming docs](https://code.claude.com/docs/en/agent-sdk/mcp); recipe only |
| `codex` | 0.169.0 | `$CODEX_HOME/config.toml`: `mcp_servers` | `computer_use` in namespace `coven-desktop-use`; `mcp__` namespace prefix is feature-dependent | Installed version/help and [pinned schema](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/config.schema.json)/[naming implementation](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-mcp/src/tools.rs); recipe only |
| `copilot` | 1.0.107 | `$COPILOT_HOME/mcp-config.json`: `mcpServers`, `type: local` | `coven-desktop-use-computer_use` | Installed version/help and [official config](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)/[naming reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference); recipe only |
| `opencode` | 1.19.5 | `opencode.json`: `mcp.servers`, command array | `coven-desktop-use_computer_use` | [Pinned native schema](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/config/mcp.ts) and [naming](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/mcp/catalog.ts); binary not installed, recipe only |
| `hermes` | 0.23.1 | `$HERMES_HOME/config.yaml`: `mcp_servers` | `mcp__coven_desktop_use__computer_use` | [Pinned configuration docs](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/website/docs/user-guide/features/mcp.md) and [naming](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/tools/mcp_tool_schema.py); binary not installed, recipe only |
| `coven-code` | 0.9.0 | Trusted engine-global `$COVEN_CODE_HOME/settings.json`: `config.mcp_servers` array | `coven-desktop-use_computer_use` | Installed version/help and [pinned config](https://github.com/OpenCoven/coven-code/blob/v0.9.0/docs/configuration.md)/[naming](https://github.com/OpenCoven/coven-code/blob/v0.9.0/src-rust/crates/mcp/src/lib.rs); recipe only |
| `grok` | No binary version qualified | `$GROK_HOME/config.toml`: `mcp_servers` | Catalog key `coven-desktop-use__computer_use`; a provider may access it through `use_tool` | [Pinned source documentation](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md); **unqualified** |
| `gemini` | 0.68.0 source only | `.gemini/settings.json`: `mcpServers` | `computer_use`, potentially qualified for a naming collision | [Pinned configuration docs](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/docs/tools/mcp-server.md); **unqualified** |
| `cursor` | No binary version qualified | `.cursor/mcp.json`: `mcpServers` | Client-selected alias, not observed | [Official MCP docs](https://cursor.com/docs/mcp); **unqualified** |
| `generic` | No harness version applies | Example `mcpServers` mapping | `computer_use` on the wire; model alias is client-specific | [MCP stdio protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports); native configuration is client-specific, **unqualified** |

The version/help probes use disposable homes and do not exercise a model. Source-derived names are not observed tool aliases and must be confirmed from the selected harness's actual discovery output before writing permission rules. OpenCode's pinned schema uses `mcp.servers`; Coven Code's MCP settings belong in trusted engine-global settings and are discarded from project settings. The six first rows are L0 checked recipes, not claims of supported harness execution. The four remaining rows explicitly stay unqualified. No recipe proves L1 discovery, L2 observations, L3 human approval, L4 lifecycle or L5 native desktop acceptance.

`pnpm run test:packed` installs the actual candidate without development dependencies, generates every recipe, parses its native command representation (including TOML), and launches that compiled command from a different disposable directory through the official MCP client. It verifies the package version, exactly one `computer_use` tool, health and Stop round trips, a policy-denied write with no effect, redacted audit and clean shutdown. This is packed command-shape evidence; the client is not Claude Code, Codex, Copilot or another real harness. Existing packed conformance separately exercises broker decisions and both supported wire revisions. Real harness qualification remains #35, and native desktop acceptance remains separate. The published npm 0.1.3 artifact remains unchanged and does not acquire these candidate entry points.

## Fixed startup diagnostics

An unsuccessful startup emits only `Desktop MCP startup unavailable [REASON].` on stderr, exits with code 1 and emits no protocol stdout. It never prints an underlying exception, path, username, configuration value or secret descriptor contents. Fix the named precondition in the trusted operator environment and restart; there is no unaudited or automatically approved fallback.

| Reason | Operator check |
| --- | --- |
| `ARGUMENTS_INVALID` | Use the documented startup flags once each; approval socket and inherited descriptor must be supplied together. |
| `RECIPE_INVALID` | Select a listed harness id and supply only supported flags with absolute literal paths. |
| `CONFIG_UNAVAILABLE` | The configuration must be readable at the absolute path and cannot be a symlink. |
| `CONFIG_UNSAFE` | Use a bounded regular file owned by the current user and not writable by group or others. |
| `CONFIG_INVALID` | Check the JSON shape, trusted scope/workspace fields and action profile. |
| `ADAPTER_PATH_INVALID` | Supply an absolute adapter path. Actual executable availability remains an execution/health diagnostic, not a startup probe. |
| `STATE_DIRECTORY_UNAVAILABLE` | Create a canonical, nonsymlink, same-user private directory with mode `0700`. |
| `AUDIT_UNAVAILABLE` | The audit destination must be writable and be a same-user regular, single-link file with mode `0600`, never a symlink or FIFO. |
| `APPROVAL_DESCRIPTOR_UNAVAILABLE` | The separate trusted host must inherit a valid bounded secret descriptor of at least 3; never place secrets in a recipe, argv or environment. |
| `STARTUP_UNAVAILABLE` | A remaining initialization or resource failure occurred; recheck trusted configuration and installation without exposing private diagnostics. |

## Separate reference host

Run `node node_modules/@opencoven/openclaw-desktop-use/dist/examples/approval-host/main.js --config /absolute/config.json` as the stdio server command in a local MCP client. This separately launched application creates a short private `/tmp/cdu-*` directory (avoiding Unix socket pathname limits), starts its Unix socket broker, generates an ephemeral secret, and launches the MCP child with that secret through inherited descriptor 3. The secret is never placed in arguments, environment variables, model-visible messages or logs. The host removes its owned socket/directory when the child exits. It does not open a TCP listener.

The reference host opens its controlling terminal independently of MCP stdin/stdout. Each prompt displays the entire canonical target, every effect parameter, policy, scope, workspace and expiry. Text is JSON-escaped, including non-ASCII characters, so terminal controls and directional formatting cannot obscure the reviewed operation. Enter `allow REVIEWCODE`, `deny REVIEWCODE` or `cancel REVIEWCODE`, using the fresh visible code in that prompt. A delayed decision from a previous review cannot approve another operation. The code is an operator correlation aid, not an approval credential. Private broker challenge identifiers are never displayed.

A missing terminal, busy prompt, invalid decision, disconnected UI or complete display larger than 16 KiB fails closed. The host does not truncate actionable information or automatically approve. Reviews may contain sensitive input and appear only in the operator terminal; do not record terminal sessions containing private work. Durable action audit continues to use the shared redaction contract.

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
