# ADR 0002: Compact MCP discovery results

- Status: Accepted; option A approved by the repository owner on 2026-11-15 and amended on 2026-11-16.
- Issue: [#52](https://github.com/OpenCoven/desktop-use/issues/52), part of #32.

## Context

MCP `health` and `doctor` returned the complete capabilities report, its duplicate adapter report, and an OpenClaw-only agent profile. Their compact structured results measured 42–56 KB. Codex without catalog model metadata truncated them, and Copilot spilled them to a file, preventing L2 observation. The harnesses budgeted `structuredContent`; their text representation was larger.

## Decision

MCP `health` and `doctor` return `capabilitySummaryV1` in place of `capabilitiesV1`. This is a projection of the validated report: action and variant eligibility comes from `discoverCapabilityControls`; each variant keeps its own modes, formats, selectors, provider, state, eligibility, and reasons. The summary omits evidence, constraints, and limits other than format. It also removes the raw adapter's duplicate report and the unrelated `agent` profile. The full report remains available through the SDK and plugin.

MCP emits compact JSON text matching `structuredContent` for every result and preserves image blocks. Connector-shaped results must be at most 8,192 bytes on both carriers. Tests cover every capability fixture, observation-only actions, failure and policy cases, data-bearing fixtures, and both supported MCP wire revisions.

## Compatibility and version

This changes the documented MCP mapping of an entry point before its first release; it is **not additive**. The execution contract and its schema identifiers remain v1. `capabilitySummaryV1` has its own versioned schema and is an optional result-details property. MCP consumers migrate to `structuredContent.capabilitySummaryV1`; consumers needing the full report use the SDK or plugin. No published release contained the MCP entry point when this decision was made.

## Measured budgets

The approved 2026-11-15 macOS arm64 receipts bisected the largest structured result delivered intact (64-byte resolution). The model column records the requested model metadata for each measurement.

| Harness | Model metadata | Largest intact | Smallest rejected | Receipt |
|---|---|---:|---:|---|
| Claude Code 2.1.325 | `claude-opus-5-5` (default) | 49,984 B | 50,048 B | [receipt](https://github.com/OpenCoven/desktop-use/blob/6a78069/docs/harness-qualification/budget/darwin-arm64/claude-code-default.json) |
| Codex CLI 0.169.0, default | `qualification` (no catalog metadata) | 11,926 B | 11,989 B | [receipt](https://github.com/OpenCoven/desktop-use/blob/6a78069/docs/harness-qualification/budget/darwin-arm64/codex-default.json) |
| Codex CLI 0.169.0, tool-search | `gpt-5.5` | 47,944 B | 48,008 B | [receipt](https://github.com/OpenCoven/desktop-use/blob/6a78069/docs/harness-qualification/budget/darwin-arm64/codex-tool-search.json) |
| Copilot CLI 1.0.107, default BYOK | `claude-sonnet-4` | 20,468 B | 20,532 B | [receipt](https://github.com/OpenCoven/desktop-use/blob/6a78069/docs/harness-qualification/budget/darwin-arm64/copilot-default.json) |
| Copilot CLI 1.0.107, vision BYOK | `claude-sonnet-4` | 20,468 B | 20,532 B | [receipt](https://github.com/OpenCoven/desktop-use/blob/6a78069/docs/harness-qualification/budget/darwin-arm64/copilot-vision.json) |

The 8 KiB limit is below the smallest measured threshold. The largest projected fixture result is 7,936 B.

## Re-qualification evidence

On implementation head `6a78069`, all five Tier A variants passed L1/L2 locally on macOS, and on Linux and hosted macOS. The CI receipts are recorded by [run 43825973558](https://github.com/OpenCoven/desktop-use/actions/runs/43825973558) and [final-head run 43826298788](https://github.com/OpenCoven/desktop-use/actions/runs/43826298788); the latter includes the final `pr53-*` receipts. These are harness/fixture observations, not native desktop acceptance.
