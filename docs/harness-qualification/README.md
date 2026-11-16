# Real-harness qualification

`scripts/qualify-harness.mjs` runs a real coding-harness binary against the desktop-use MCP connector, a fixture adapter and a deterministic local model endpoint. It writes one receipt for levels L1 and L2 of the support ladder (#35).

This evidence class is "real harness, fixture adapter". A receipt shows what the harness does with `computer_use`: whether the model sees the tool, and what reaches the model after each call. It is not native desktop acceptance (L5) and it makes no claim about model quality.

## Running

```sh
pnpm run build
node scripts/qualify-harness.mjs --harness codex --connector packed --out codex.json
node scripts/harness-qualification/summarize.mjs codex.json
```

| Option | Meaning |
|---|---|
| `--harness <id>` | `claude-code`, `codex`, `copilot`, `coven-code`, or one of the recorded blockers `opencode`, `hermes` |
| `--variant <name>` | `codex`: `default` or `tool-search`. `copilot`: `default` or `vision`. `coven-code`: `default` (`settings.json`) or `inline` (`--mcp-config`). |
| `--bin <path>` | Harness executable. The default is the harness's command on `PATH`. |
| `--connector <source>` | `built` (default: this checkout's `dist`), `packed` (pack this checkout and install it outside the repository), a `.tgz` tarball, or an explicit `main.js` |
| `--level L1\|L2` | Highest level to qualify (default `L2`) |
| `--probe-bytes <n>` | Budget probe (#52): replace the connector with a size probe whose `computer_use` result has exactly `n` compact bytes of `structuredContent` |
| `--probe-text compact\|pretty` | With `--probe-bytes`: whether `content[0].text` is compact or pretty-printed JSON (default `compact`) |
| `--timeout <s>` | Harness run limit (default 150) |
| `--out <file>` | Receipt path (default: stdout) |
| `--keep` | Keep the disposable run directory for debugging |

Exit codes: `0` pass, `1` fail, `2` unqualified, `64` usage.

## What a run does

- **Isolation.** Every run gets a new temporary directory holding `HOME`, the `XDG_*` directories, the harness's own config directory, `TMPDIR`, the workspace and the connector state. It is deleted afterwards. The harness starts with a minimal environment, so no credentials are inherited, and the operator's own harness configuration is never read.
- **Connector.** Each run uses its own `--config`, the `observation-only` action profile, and a fixture adapter:
  - `doctor` and `health` return a synthetic capabilities report from `contracts/v1/fixtures/capabilities/`.
  - `screenshot` writes the shared v1 PNG, `contracts/v1/fixtures/images/valid.png`.
  - Nothing touches the desktop.
- **Model.** A local HTTP endpoint speaks Anthropic Messages (Claude Code, Copilot BYOK) or OpenAI Responses (Codex). Its scripted model calls `health`, then `screenshot`, then ends the turn. It records only derived facts:
  - tool names and schema keys;
  - result shape, sizes and status;
  - image media types, lengths and whether the bytes match the fixture hash.

  It never records prompts, headers, credentials or image bytes.
- **Receipt guards.** The runner refuses to write a receipt that contains any of these:
  - the run directory, home, repository or temp path;
  - the per-run private `reason` marker sent with each call;
  - the image bytes.

  It also refuses a receipt whose overall verdict disagrees with its levels.

## Levels and verdicts

- **L1, discovery.** The model is offered exactly one desktop tool, and it is named `computer_use`. The tool may be listed up front or found through the harness's own deferred tool search. When the harness reaches the endpoint but never starts the connector, which opens its audit file at startup, the failure reason is `mcp-server-not-started`.
- **L2, observation.** The `health` and `screenshot` results both reach the model with the structured result intact (`delivered`) and status `success`.
  - Image handling is recorded but not scored: `delivered` (the byte-identical fixture PNG), `transformed` (an image with other bytes or another type) or `dropped`. A dropped image also gets `textPlaceholder` when the harness says it removed one.
- **Verdicts.** Each level is `pass`, `fail` or `unqualified`. `unqualified` means the run could not observe the level: a missing binary, no runner recipe, or a harness that never reached the endpoint.
  - When levels are combined, `fail` beats `unqualified`, and `unqualified` beats `pass`, so an unqualified level never produces a pass.
  - `scripts/qualify-harness.test.mjs` proves this, including mutation-checked receipt validation.

## Launch recipes

| Harness | Endpoint | MCP configuration |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` | `-p --bare --mcp-config <file> --strict-mcp-config --allowedTools mcp__coven-desktop-use__computer_use` |
| Codex CLI | `[model_providers.*] base_url`, `wire_api = "responses"` | `exec --skip-git-repo-check`; `[mcp_servers.coven-desktop-use]` with `default_tools_approval_mode = "approve"` and `startup_readiness = "catalog"`; `[features] plugins = false` |
| GitHub Copilot CLI | BYOK: `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE=anthropic`, `COPILOT_OFFLINE=true`; no GitHub authentication | `-p --additional-mcp-config @<file> --allow-tool coven-desktop-use --disable-builtin-mcps`; `vision` adds `COPILOT_PROVIDER_VISION=true` |
| Coven Code | `--provider anthropic --api-base` | `-p --allowed-tools mcp__coven-desktop-use__computer_use`; the server is an entry in the `mcpServers` array in `~/.coven-code/settings.json` (`inline`: the same JSON as `--mcp-config`) |

These are qualification launch shapes, not user recipes. User recipes are #34.

## macOS receipts, 2026-11-15

Recorded on macOS (Darwin 27.2.0), arm64, Quartz, Node 24.22.0, with packed connectors. Receipts are in [`receipts/darwin-arm64/`](receipts/darwin-arm64/).

The two connector builds:
- `main`: tarball `d4141f9e1ea9…`, packed from `main` at `3b57d45` (this branch adds only the runner).
- #50: tarball `3b7e91f163a2…`, the #41 fix at `348bf14`.

| Harness | Variant | `main` L1 / L2 | #50 L1 / L2 | `health` result to model | Screenshot image |
|---|---|---|---|---|---|
| Claude Code 2.1.325 | default | **fail** (not listed) / fail | pass / **pass** | delivered | delivered, byte-identical |
| Codex CLI 0.169.0 | default (unknown model slug) | pass / fail | pass / fail | truncated to 12,020 of ~43,900 characters | dropped |
| Codex CLI 0.169.0 | tool-search (`gpt-5.5` metadata) | pass / **pass** | pass / **pass** | delivered, after a harness prefix | dropped |
| GitHub Copilot CLI 1.0.107 | default (BYOK) | pass / fail | pass / fail | spilled to a file; the model gets a 921-character preview | dropped, with an "omitted" notice |
| GitHub Copilot CLI 1.0.107 | vision (BYOK) | pass / fail | pass / fail | spilled, as above | delivered, byte-identical |
| Coven Code 0.9.0 | default (`settings.json`) and inline (`--mcp-config`) | **fail** (`mcp-server-not-started`) / fail | same | | |
| OpenCode, Hermes | — | unqualified (`no-runner-recipe`) | | | |

In every run that started the connector, it exited with the harness. No other process outlived any harness, and no audit held private input.

## Findings

**Claude Code 2.1.325**
- On `main` it drops `computer_use` and logs `Skipping tool "computer_use": its input schema uses top-level allOf, which the Anthropic API does not accept.` (#41).
- With #50 it passes L1 and L2, and the screenshot reaches the model as a byte-identical image block in the tool result.

**Codex CLI 0.169.0**
- **Discovery.** With an unknown model slug, Codex lists MCP tools up front. With `gpt-5.5` metadata it defers them behind the client-side `tool_search` tool, so the model must search first. The scripted model does that in the `tool-search` variant.
- **Images are always dropped.** When an MCP result has `structuredContent`, Codex sends only the serialized `structuredContent` as text, and drops `content` along with any image. See `CallToolResult::as_function_call_output_payload` in `codex-rs/protocol/src/models.rs` at `rust-v0.169.0`. It also prefixes results with `Wall time: … Output:`.
- **Truncation.** With an unknown model slug, tool output is cut to about 12 KB, so the 43.9 KB `health` result arrives truncated. With `gpt-5.5` metadata it arrives whole. Since #52, `health` fits in both cases: see [Compact discovery results](#compact-discovery-results-52-pr-53).
- **Intermittent empty search.** `tool_search` sometimes returned no tools. That happened in 2 of 13 runs with the `main` build and 0 of 11 with the #50 build, with the host at load average 100–250. The cause is unconfirmed, and the runner does not retry.
- **Curated plugin sync.** The `plugins` feature (stable, on by default) clones `github.com/openai/plugins` at startup. With it enabled, one process outlived Codex's exit in both variants. The recipe sets `[features] plugins = false`.
- Codex forwards a top-level `allOf` unchanged.

**GitHub Copilot CLI 1.0.107**
- **BYOK.** BYOK mode needs no GitHub authentication, so Copilot qualifies against the local endpoint. This withdraws the earlier "needs an authorized test token" blocker.
- **Tool and schema.** The tool is listed as `coven-desktop-use-computer_use`. Copilot rewrites the schema: it drops `$schema`, `$id` and the top-level `allOf`, and adds `description`.
- **Large results spill.** Results above an inline limit go to a session file, and the model gets a 500-character preview. The 43.9 KB `health` result therefore fails L2 in every variant. The limit is 20,468 B (see [Tool-output budgets](#tool-output-budgets-52)), and since #52 `health` fits.
- **Images.** BYOK models are text-only by default, so the image is replaced with an "image attachment was omitted" notice. `COPILOT_PROVIDER_VISION=true` delivers it byte-identical.

**OpenCode and Hermes** are not installed on this host and have no runner recipe.

**Coven Code 0.9.0** reaches the local endpoint but never starts the MCP server in print mode, so the model sees only built-in tools (including `ToolSearch` and `mcp__auth`).
- This held for every form tried: the documented `mcpServers` array in `~/.coven-code/settings.json`, and inline `--mcp-config` as either an array or a map.
- It also held with `--dangerously-skip-permissions` in place of the tool allowlist.
- In every case the connector's state directory stayed empty, and the run ended after one model request.
- Coven Code is OpenCoven's own harness, so the fix belongs in Coven Code or its recipe (#34).

## Linux and hosted macOS

`.github/workflows/harness-qualification.yml` runs the same matrix on `ubuntu-latest` and `macos-latest`, with pinned harness versions, the packed connector and no credentials. It uploads the receipts as artifacts.

The verdicts are evidence, not a gate. The job fails only when the runner errors or a receipt is inconsistent.

Run `43785457470` recorded these receipts at `6a8e5b5`. They are in [`receipts/linux-x64-ci/`](receipts/linux-x64-ci/) (Ubuntu, kernel 7.0.0-1017-azure, x64, no display server) and [`receipts/darwin-arm64-ci/`](receipts/darwin-arm64-ci/) (hosted macOS, Darwin 25.6.0).

The hosted runs packed `main`'s connector (tarball `d4141f9e1ea9…`), byte-identical to the local `main` tarball. Every harness gave the same result on Linux as on macOS:

| Harness | L1 / L2 on Linux | Screenshot image |
|---|---|---|
| Claude Code 2.1.325 | **fail** (not listed: #41) / fail | — |
| Codex CLI 0.169.0, default | pass / fail (`health` truncated) | dropped |
| Codex CLI 0.169.0, tool-search | pass / **pass** | dropped |
| Copilot CLI 1.0.107, default | pass / fail (`health` spilled) | dropped, with an "omitted" notice |
| Copilot CLI 1.0.107, vision | pass / fail (`health` spilled) | delivered, byte-identical |
| Coven Code | unqualified (`binary-not-found`): not installed on runners | |
| OpenCode, Hermes | unqualified (`no-runner-recipe`) | |

Claude Code with the #41 fix (#50) has not been run on Linux yet. Its Linux receipt follows once #50 merges and this workflow packs the fixed connector.

## Tool-output budgets (#52)

`scripts/harness-qualification/measure-budget.mjs` bisects the largest `computer_use` result a harness delivers to the model intact:

```sh
node scripts/harness-qualification/measure-budget.mjs --harness codex --text pretty --out codex-default.json
```

Each probe is a full qualification run with `--probe-bytes`. The size probe replaces the connector and pads `structuredContent` with real capability entries to an exact compact size. A size counts as intact when the model receives parseable structured content of at least that size. The default resolution is 64 B.

Recorded on macOS (Darwin 27.2.0), arm64, on 2026-11-15, with a pretty-printed text carrier. The results are in [`budget/darwin-arm64/`](budget/darwin-arm64/).

| Harness | Requested model | Largest intact | Smallest rejected | Model received instead |
|---|---|---|---|---|
| Claude Code 2.1.325 | `claude-opus-5-5` (harness default) | 49,984 B | 50,048 B | a 2,384-character preview of a stored file |
| Codex CLI 0.169.0, default | `qualification` (no catalog metadata) | 11,926 B | 11,989 B | 12,020 characters, truncated in the middle |
| Codex CLI 0.169.0, tool-search | `gpt-5.5` (bundled catalog) | 47,944 B | 48,008 B | 48,020 characters, truncated in the middle |
| Copilot CLI 1.0.107, BYOK | `claude-sonnet-4` | 20,468 B | 20,532 B | a 921-character preview of a spilled file |
| Copilot CLI 1.0.107, BYOK vision | `claude-sonnet-4` | 20,468 B | 20,532 B | the same |

- **All three harnesses budget the compact `structuredContent`, not the text.**
  - A compact-text run gave exactly the same thresholds. It was recorded before the receipts named the requested model, and it is in [`budget/darwin-arm64/compact-text/`](budget/darwin-arm64/compact-text/).
  - With 12,000 B of structured content and 21,959 B of pretty text, Copilot delivered the 12,000 B.
- **A cut result can still parse.** Codex keeps the head and tail of a long output. When the cut falls inside one long string, the rest can still parse: at 48,199 B the model got parseable JSON of only 48,020 characters. The size check catches this for the probe. Connector results stay far below every limit once #52 lands.
- **The fix.** ADR [0002](../adr/0002-compact-mcp-discovery-results.md) keeps every connector-shaped observation-only result within 8 KiB. `src/mcp/result-budget.test.ts` enforces that for every capability fixture.

## Compact discovery results (#52, PR #53)

With ADR 0002, MCP `health` sends the model `capabilitySummaryV1` instead of the full report. The macOS fixture result drops from 43,921 to 5,834 characters (5,868 under Codex, with its prefix).

Three connector builds, all packed:
- **#53** at `4628718`. It is stacked on #51 and does not include the #41 fix:
  - local tarball `963e637f6612…`;
  - CI tarball `3c03f7f1b490…`, packed by the workflow from the same commit.
- **#50 + #53**: a local merge of #50 (`348bf1477ee4`, the #41 fix) with #53, tarball `885c16838858…`. This is the state after the planned merge order.

| Harness | macOS, #53 | macOS, #50 + #53 | Linux CI, #53 | Hosted macOS CI, #53 | Screenshot image |
|---|---|---|---|---|---|
| Claude Code 2.1.325 | fail (not listed: #41) | **pass / pass** | fail (not listed: #41) | fail (not listed: #41) | delivered, byte-identical |
| Codex CLI 0.169.0, default | **pass / pass** | **pass / pass** | **pass / pass** | **pass / pass** | dropped |
| Codex CLI 0.169.0, tool-search | **pass / pass** | **pass / pass** | **pass / pass** | **pass / pass** | dropped |
| Copilot CLI 1.0.107, default | **pass / pass** | **pass / pass** | **pass / pass** | **pass / pass** | dropped, with an "omitted" notice |
| Copilot CLI 1.0.107, vision | **pass / pass** | **pass / pass** | **pass / pass** | **pass / pass** | delivered, byte-identical |

Cells are L1 / L2.

Where the receipts are:
- local runs: [`receipts/darwin-arm64/`](receipts/darwin-arm64/) (`pr53-*`, `pr50-53-*`);
- CI run `43794185081`: [`receipts/linux-x64-ci/`](receipts/linux-x64-ci/) and [`receipts/darwin-arm64-ci/`](receipts/darwin-arm64-ci/) (`pr53-*`).

In every run, the connector exited with the harness, no other process outlived it, and the audit held no private input.

Claude Code's L2 on Linux follows once #50 merges and this branch is rebased. Its macOS result with #50 shows that the fix and the projection work together.

## Not covered yet

- **L3, gated effects:** needs the approval routing from #33 (PR #49).
- **L4, lifecycle:** interrupt mid-review, session end, and same-scope versus cross-scope Stop.

Receipts already record whether the connector and other processes outlive the harness, and whether the audit holds private input.
