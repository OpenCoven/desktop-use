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
| `--harness <id>` | `claude-code`, `codex`, `copilot`, or one of the recorded blockers `opencode`, `hermes`, `coven-code` |
| `--variant <name>` | `codex`: `default` or `tool-search`. `copilot`: `default` or `vision`. |
| `--bin <path>` | Harness executable. The default is the harness's command on `PATH`. |
| `--connector <source>` | `built` (default: this checkout's `dist`), `packed` (pack this checkout and install it outside the repository), a `.tgz` tarball, or an explicit `main.js` |
| `--level L1\|L2` | Highest level to qualify (default `L2`) |
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

- **L1, discovery.** The model is offered exactly one desktop tool, and it is named `computer_use`. The tool may be listed up front or found through the harness's own deferred tool search.
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
| OpenCode, Hermes | — | unqualified (`no-runner-recipe`) | | | |
| Coven Code | — | unqualified (`no-runner-recipe`) | | | |

In every run the connector exited with the harness, no other process outlived it, and the audit held no private input.

## Findings

**Claude Code 2.1.325**
- On `main` it drops `computer_use` and logs `Skipping tool "computer_use": its input schema uses top-level allOf, which the Anthropic API does not accept.` (#41).
- With #50 it passes L1 and L2, and the screenshot reaches the model as a byte-identical image block in the tool result.

**Codex CLI 0.169.0**
- **Discovery.** With an unknown model slug, Codex lists MCP tools up front. With `gpt-5.5` metadata it defers them behind the client-side `tool_search` tool, so the model must search first. The scripted model does that in the `tool-search` variant.
- **Images are always dropped.** When an MCP result has `structuredContent`, Codex sends only the serialized `structuredContent` as text, and drops `content` along with any image. See `CallToolResult::as_function_call_output_payload` in `codex-rs/protocol/src/models.rs` at `rust-v0.169.0`. It also prefixes results with `Wall time: … Output:`.
- **Truncation.** With an unknown model slug, tool output is cut to about 12 KB, so the 43.9 KB `health` result arrives truncated. With `gpt-5.5` metadata it arrives whole.
- **Intermittent empty search.** `tool_search` sometimes returned no tools. That happened in 2 of 12 runs with the `main` build and 0 of 10 with the #50 build, with the host at load average 100–250. The cause is unconfirmed, and the runner does not retry.
- **Curated plugin sync.** The `plugins` feature (stable, on by default) clones `github.com/openai/plugins` at startup. With it enabled, one process outlived Codex's exit in both variants. The recipe sets `[features] plugins = false`.
- Codex forwards a top-level `allOf` unchanged.

**GitHub Copilot CLI 1.0.107**
- **BYOK.** BYOK mode needs no GitHub authentication, so Copilot qualifies against the local endpoint. This withdraws the earlier "needs an authorized test token" blocker.
- **Tool and schema.** The tool is listed as `coven-desktop-use-computer_use`. Copilot rewrites the schema: it drops `$schema`, `$id` and the top-level `allOf`, and adds `description`.
- **Large results spill.** Results above an inline limit go to a session file, and the model gets a 500-character preview. The 43.9 KB `health` result therefore fails L2 in every variant.
- **Images.** BYOK models are text-only by default, so the image is replaced with an "image attachment was omitted" notice. `COPILOT_PROVIDER_VISION=true` delivers it byte-identical.

**OpenCode and Hermes** are not installed on this host and have no runner recipe.

**Coven Code 0.9.0** is installed, but has no verified recipe: earlier runs didn't start the MCP server from `settings.json` or `--mcp-config`.

## Linux and hosted macOS

`.github/workflows/harness-qualification.yml` runs the same matrix on `ubuntu-latest` and `macos-latest`, with pinned harness versions, the packed connector and no credentials. It uploads the receipts as artifacts.

The verdicts are evidence, not a gate. The job fails only when the runner errors or a receipt is inconsistent.

## Not covered yet

- **L3, gated effects:** needs the approval routing from #33 (PR #49).
- **L4, lifecycle:** interrupt mid-review, session end, and same-scope versus cross-scope Stop.

Receipts already record whether the connector and other processes outlive the harness, and whether the audit holds private input.
