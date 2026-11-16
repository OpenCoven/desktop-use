# Coding harnesses

`computer_use` is available through the local stdio MCP connector. Use the exact locally packed candidate described in [the client guide](desktop-client.md#local-candidate-consumption), Node `>=22.14.0`, and an intentionally installed adapter. Published npm `0.1.3` predates these SDK/MCP entries. Harness qualification uses a fixture adapter and a deterministic local model endpoint; native desktop actions require separate acceptance.

This snapshot was checked on 2026-11-16 UTC. Support depends on the harness version, launch variant, connector artifact and platform recorded below. A passing observation level can coexist with dropped images; inspect the image column before choosing a harness for visual work.

## Levels and evidence identity

| Level | Required evidence |
|---|---|
| L0 | A print-only native configuration recipe checked against pinned source or documentation. |
| L1 | A real harness offers exactly one desktop tool, `computer_use`, to the model. |
| L2 | Successful `health` and `screenshot` structured results reach the model intact; image handling is recorded separately. |
| L3 | Trusted approval authorizes exactly one effect; negative decisions and harness bypass modes authorize none. |
| L4 | Pending and active cancellation, interruption, exit, session end, cleanup, audit and same-session/cross-session Stop are qualified. |
| L5 | An observed native graphical action through that harness on the named platform. |

Levels form a ladder. Individual approval examples and cleanup observations do not establish L3 or L4 while their other required cases remain unverified. Fixture screenshots establish transport behavior; they do not establish Screen Recording grants, Accessibility grants or desktop geometry.

The recipe source is [PR 43 at `381feaa1661261afacbd6f5e3c0226847f9b0d86`][recipes]. The real-harness receipt snapshot is [PR 51 at `20464d48804f8c82b834d5d7b2441a1712989e59`][qualification]. Its macOS `pr50` receipts identify packed connector SHA256 `3b7e91f163a2fc74c5aaecfe2afd1d828adbbdc4335e70767d0cca75b28aec6c`, described by the producer as the schema fix at `348bf1477ee49ac5ae703980b409d806f035b739`. Its Linux receipts identify packed connector SHA256 `d4141f9e1ea9ab2689b7d79aa7da1b15a3c2d5b8f986d982446ed75a2c835050`, described as main at `3b57d45f60fbdd0d10dcf7baeccd24da2c114c0d`. The receipts' connector `commit` fields are null, so the tarball hashes are the direct artifact identities; these are historical observations, not final combined-candidate acceptance.

Local macOS receipts were recorded on 2026-11-16 UTC with Darwin `27.2.0`, arm64, Quartz and Node `24.22.0`. Linux receipts were recorded on the same date by existing workflow run `43785457470`, Ubuntu x64, kernel `7.0.0-1017-azure`, no display server and Node `24.22.2`. The runner source for that hosted run was `6a8e5b5`; its connector artifact identity is recorded separately above. No new hosted run is implied by this guide.

## Recipe registry

Versions in this table are the recipe command's checked source/documentation pins. Real execution pins are listed in the receipt matrix. Tier C remains unqualified even when a template exists.

<!-- harness-registry:start -->
| Recipe ID | Harness | Checked version | Tier / recipe status |
|---|---|---|---|
| `claude` | Claude Code | 2.1.325 | A; recipe only |
| `codex` | Codex CLI | 0.169.0 | A; recipe only |
| `copilot` | GitHub Copilot CLI | 1.0.107 | A; recipe only |
| `opencode` | OpenCode | 1.19.5 | B; recipe only |
| `hermes` | Hermes | 0.23.1 | B; recipe only |
| `coven-code` | Coven Code | 0.9.0 | B; recipe only; launch discrepancy below |
| `grok` | Grok Build | Unpinned | C; unqualified template |
| `gemini` | Gemini CLI | 0.68.0 | C; unqualified template |
| `cursor` | Cursor | Unpinned | C; unqualified template |
| `generic` | Generic MCP client | Unpinned | C; unqualified protocol example |
<!-- harness-registry:end -->

## Platform support matrix

Claude Code is `2.1.325`, Codex CLI `0.169.0`, Copilot CLI `1.0.107`, and local Coven Code `0.9.0`. OpenCode and Hermes have no real-harness execution pin in these receipts. The Linux Claude Code receipt uses the older connector and fails schema discovery; the fixed connector has only macOS evidence in this snapshot. An unqualified or failed cell remains visible even when another variant passes.

<!-- harness-matrix:start -->
| Recipe ID | Platform | L0 | L1 | L2 | L3 | L4 | L5 | Image |
|---|---|---|---|---|---|---|---|---|
| `claude` | macOS | [Recipe only][recipes] | [Pass][mac-claude] | [Pass][mac-claude] | Unverified | Unverified | Unverified | [Delivered, byte identical][mac-claude] |
| `codex` | macOS | [Recipe only][recipes] | [Pass][mac-codex] | [Fail: default][mac-codex]; [pass: tool-search][mac-codex-search] | Unverified | Unverified | Unverified | [Dropped][mac-codex-search] |
| `copilot` | macOS | [Recipe only][recipes] | [Pass][mac-copilot] | [Fail: health spilled][mac-copilot] | Unverified | Unverified | Unverified | [Dropped: default][mac-copilot]; [delivered: vision][mac-copilot-vision] |
| `opencode` | macOS | [Recipe only][recipes] | [Unqualified: no runner recipe][mac-opencode] | [Unqualified][mac-opencode] | Unverified | Unverified | Unverified | Unverified |
| `hermes` | macOS | [Recipe only][recipes] | [Unqualified: no runner recipe][mac-hermes] | [Unqualified][mac-hermes] | Unverified | Unverified | Unverified | Unverified |
| `coven-code` | macOS | [Recipe only][recipes] | [Fail: MCP server not started][mac-coven-code] | [Fail][mac-coven-code] | Unverified | Unverified | Unverified | Unverified |
| `grok` | macOS | [Template; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `gemini` | macOS | [Template; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `cursor` | macOS | [Template; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `generic` | macOS | [Example; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `claude` | Linux | [Recipe only][recipes] | [Fail: schema rejected][linux-claude] | [Fail][linux-claude] | Unverified | Unverified | Unverified | Unverified |
| `codex` | Linux | [Recipe only][recipes] | [Pass][linux-codex] | [Fail: default][linux-codex]; [pass: tool-search][linux-codex-search] | Unverified | Unverified | Unverified | [Dropped][linux-codex-search] |
| `copilot` | Linux | [Recipe only][recipes] | [Pass][linux-copilot] | [Fail: health spilled][linux-copilot] | Unverified | Unverified | Unverified | [Dropped: default][linux-copilot]; [delivered: vision][linux-copilot-vision] |
| `opencode` | Linux | [Recipe only][recipes] | [Unqualified: no runner recipe][linux-opencode] | [Unqualified][linux-opencode] | Unverified | Unverified | Unverified | Unverified |
| `hermes` | Linux | [Recipe only][recipes] | [Unqualified: no runner recipe][linux-hermes] | [Unqualified][linux-hermes] | Unverified | Unverified | Unverified | Unverified |
| `coven-code` | Linux | [Recipe only][recipes] | [Unqualified: binary not found][linux-coven-code] | [Unqualified][linux-coven-code] | Unverified | Unverified | Unverified | Unverified |
| `grok` | Linux | [Template; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `gemini` | Linux | [Template; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `cursor` | Linux | [Template; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| `generic` | Linux | [Example; unqualified][recipes] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
<!-- harness-matrix:end -->

OpenClaw uses the plugin path described in [the MCP guide](mcp.md) and [the client contract](desktop-client.md); these coding-harness receipts do not replace gateway qualification. Windows native desktop actions remain unsupported for every harness. A generic MCP client passes wire-level checks without establishing a named coding harness's model delivery or lifecycle behavior.

### Known gaps and next evidence

- Claude Code needs the advertised-schema fix from [PR 50](https://github.com/OpenCoven/desktop-use/pull/50). The Linux receipt above predates that fix.
- Codex drops typed image content when it forwards `structuredContent`. Default model metadata also truncates the large health report; the `tool-search` variant delivers that structured report but still drops the image. A passing L2 cell therefore provides no visual-input assurance.
- Copilot's default mode drops images. Its `vision` variant delivered the exact fixture image, while the health report still spilled to a file and failed L2. The separate discovery-result budget work is tracked in [issue 52](https://github.com/OpenCoven/desktop-use/issues/52).
- OpenCode and Hermes are explicitly unqualified by the runner. Coven Code's local print-mode run reached the model endpoint without starting MCP; its Linux binary was unavailable. Keep these concrete blockers until new receipts replace them.
- [PR 49](https://github.com/OpenCoven/desktop-use/pull/49) contains broker/PTY tests and partial macOS real-harness approval examples. Complete L3/L4 requires the remaining real-harness, platform and lifecycle cases in [issue 35](https://github.com/OpenCoven/desktop-use/issues/35), including pending and active interruption and cross-session isolation.

## Preparing a recipe

Run the print-only recipe command from the exact installed candidate. It emits a JSON envelope containing the harness-native configuration snippet, checked source/version, expected tool name and a separate trusted connector configuration template. Recipe mode reads no startup configuration, starts no connector and creates no files. Replace absolute placeholders and manually review the output before configuring a disposable harness home.

The trusted connector configuration must be a user-owned regular file with mode `0600`; its canonical state directory must be user-owned with mode `0700` and outside model-writable workspaces. Select an absolute adapter path. The template defaults to `observation-only`. See [trusted startup configuration](mcp.md) for the complete contract.

Harness tool permissions only determine whether the harness can call the tool. Gated desktop effects require a trusted approval provider. For a harness that owns its terminal, [the operator-launched approver in PR 49](https://github.com/OpenCoven/desktop-use/pull/49) runs in its own foreground terminal and supplies the separate `attach` command. Each attached session has its own connector. Treat access to that socket directory as access to observations; harness permission prompts and auto-approve modes do not supply desktop approval. Keep the directory outside model-writable workspaces and deny sandbox access unless the session is intentionally attached.

### Recipe: `claude`

```sh
coven-desktop-use-mcp recipe --harness claude
```

The output contains an `mcpServers` JSON entry for `.mcp.json`. The pinned real run used a disposable `--mcp-config` file, `--strict-mcp-config` and `--allowedTools mcp__coven-desktop-use__computer_use`. Expected model alias: `mcp__coven-desktop-use__computer_use`. The schema fix is required for Claude Code `2.1.325`.

### Recipe: `codex`

```sh
coven-desktop-use-mcp recipe --harness codex
```

The output contains a TOML `[mcp_servers.coven-desktop-use]` entry for a disposable `CODEX_HOME/config.toml`. The pinned qualification additionally used `startup_readiness = "catalog"`, `default_tools_approval_mode = "approve"` with `approval_policy = "never"`, and `[features] plugins = false`. These observed launch settings are not included in the recipe snapshot above. Review the harness settings separately before use; desktop approval still comes from the trusted provider. Model metadata can defer discovery behind `tool_search`; the observed namespace is `mcp__coven_desktop_use`.

### Recipe: `copilot`

```sh
coven-desktop-use-mcp recipe --harness copilot
```

The output contains an `mcpServers` JSON entry with `type: "local"`. The real run used `--additional-mcp-config @<disposable-file>`, `--allow-tool coven-desktop-use` and `--disable-builtin-mcps`; it called `coven-desktop-use-computer_use`. Qualification used Copilot's BYOK local-endpoint mode with `COPILOT_OFFLINE=true` and required no GitHub token. `COPILOT_PROVIDER_VISION=true` changed image handling in that fixture run; it did not fix the spilled health result.

### Recipe: `opencode`

```sh
coven-desktop-use-mcp recipe --harness opencode
```

The output uses OpenCode's `mcp.servers` JSON shape with the executable and arguments in a command array. The alias `coven-desktop-use_computer_use` is expected from pinned source, unverified in a real harness. The runner currently reports `no-runner-recipe`.

### Recipe: `hermes`

```sh
coven-desktop-use-mcp recipe --harness hermes
```

The output is quoted JSON usable as YAML, with an `mcp_servers` entry in the disposable Hermes configuration. The source-expected alias is `mcp__coven_desktop_use__computer_use`; real-harness delivery is unverified and the runner reports `no-runner-recipe`.

### Recipe: `coven-code`

```sh
coven-desktop-use-mcp recipe --harness coven-code
```

The recipe snapshot emits the trusted engine-global `config.mcp_servers` array. The real runner instead tried the print-mode documented `mcpServers` array in disposable `settings.json`, plus inline `--mcp-config`; neither started MCP. Those are different configuration surfaces. Their compatibility and the expected alias are unverified; preserve the startup failure until the Coven Code or recipe owner supplies a working receipt.

### Recipe: `grok`

```sh
coven-desktop-use-mcp recipe --harness grok
```

The unqualified template uses TOML `mcp_servers`. Its source check is pinned to a documentation commit, with no executable version qualified. Model aliases and all real-harness levels are unverified.

### Recipe: `gemini`

```sh
coven-desktop-use-mcp recipe --harness gemini
```

The unqualified JSON template targets `.gemini/settings.json`, checked against Gemini CLI `0.68.0` documentation. The wire tool is `computer_use`; model aliasing and execution are unverified.

### Recipe: `cursor`

```sh
coven-desktop-use-mcp recipe --harness cursor
```

The unqualified JSON template targets `.cursor/mcp.json`. No Cursor executable version, model alias or real-harness level is qualified.

### Recipe: `generic`

```sh
coven-desktop-use-mcp recipe --harness generic
```

The unqualified example uses an `mcpServers` envelope; that envelope is client configuration rather than a requirement of the MCP protocol. The wire tool is `computer_use`; choose the configuration and model alias required by the actual client.

## macOS permissions and repair

Fixture receipts do not establish which responsible process macOS attributes a privacy request to. This guide has no verified per-harness Screen Recording or Accessibility attribution. The fixture runs above report Darwin `27.2.0` locally and Darwin `25.6.0` on hosted macOS; native attribution remains unverified on both. Do not infer grants from a successful protocol handshake, helper inventory or fixture screenshot.

| Harness | Launcher chain to inspect | Screen Recording attribution | Accessibility attribution | OS evidence |
|---|---|---|---|---|
| Claude Code 2.1.325 | Terminal app → Claude → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| Claude Code 2.1.325 | IDE's terminal → Claude → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| Claude Code 2.1.325 | Service → Claude → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| Codex CLI 0.169.0 | Terminal app → Codex → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| Codex CLI 0.169.0 | IDE's terminal → Codex → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| Codex CLI 0.169.0 | Service → Codex → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| GitHub Copilot CLI 1.0.107 | Terminal app → Copilot → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| GitHub Copilot CLI 1.0.107 | IDE's terminal → Copilot → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| GitHub Copilot CLI 1.0.107 | Service → Copilot → Node/adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture runs only |
| Claude Code 2.1.325 via attach | Separate operator terminal → approver → connector → adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture evidence only; native attach attribution untested |
| Codex CLI 0.169.0 via attach | Separate operator terminal → approver → connector → adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture evidence only; native attach attribution untested |
| GitHub Copilot CLI 1.0.107 via attach | Separate operator terminal → approver → connector → adapter/Peekaboo | Unverified | Unverified | Darwin 27.2.0 / 25.6.0 fixture evidence only; native attach attribution untested |

The terminal, IDE and service rows describe direct connector launches. With `attach`, the harness starts the relay while the operator's separate approver launches the connector and desktop helpers. Inspect the approver's actual launcher chain for that configuration. The attach permission rows express unverified attribution; they do not add platform or real-harness approval qualification.

Inspect the actual launching process and the binaries you intentionally installed. For a real permission denial, review System Settings → Privacy & Security → Screen Recording and Accessibility for that launch chain. Attribution can differ between a terminal, an IDE and a service. An operator should grant access only to the intended responsible process, restart the granted launcher, and run `computer_use` with `action: "doctor"` again. Confirm a controlled native capture or action separately before claiming native support. Never reset or pre-authorize the privacy database as part of this procedure.

SDK repair advice names the trusted SDK `adapterPath` option. MCP advice names the trusted MCP configuration `adapterPath`. Missing or nonexecutable adapters are adapter spawn failures when `health` or `doctor` invokes the adapter; they do not imply missing privacy grants or prevent the connector itself from starting. For an explicit macOS denial, `permissionFlow` names the Screen Recording and Accessibility panes and tells the operator to restart the actual SDK/MCP client launcher; OpenClaw Gateway restart advice applies to the plugin surface. An unavailable Peekaboo helper is a separate dependency failure.

## Refreshing support claims

Retain the first failed receipt and its exact harness, OS, display server, launch variant and connector artifact identity. After changing a candidate, rerun the relevant real-harness cases and the full local `pnpm run check` and `pnpm run test:packed` gates. Update each affected matrix cell from its new receipt. Keep image loss, incomplete lifecycle cases and absent native evidence visible. Scheduled CI/drift reporting is separate work in issue 36; release publication remains issue 25.

[recipes]: https://github.com/OpenCoven/desktop-use/blob/381feaa1661261afacbd6f5e3c0226847f9b0d86/src/mcp/recipes.ts
[qualification]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/README.md
[mac-claude]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/pr50-claude-code-default.json
[mac-codex]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/pr50-codex-default.json
[mac-codex-search]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/pr50-codex-tool-search.json
[mac-copilot]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/pr50-copilot-default.json
[mac-copilot-vision]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/pr50-copilot-vision.json
[mac-opencode]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/any-opencode-default.json
[mac-hermes]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/any-hermes-default.json
[mac-coven-code]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/darwin-arm64/pr50-coven-code-default.json
[linux-claude]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/claude-code-default.json
[linux-codex]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/codex-default.json
[linux-codex-search]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/codex-tool-search.json
[linux-copilot]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/copilot-default.json
[linux-copilot-vision]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/copilot-vision.json
[linux-opencode]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/opencode-default.json
[linux-hermes]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/hermes-default.json
[linux-coven-code]: https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/linux-x64-ci/coven-code-default.json
