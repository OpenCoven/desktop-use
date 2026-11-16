# ADR 0002: Return a compact capability summary from MCP `health` and `doctor`

- Status: Accepted. The owner signed off on option A on 2026-11-15, together with two scope decisions (recorded on #52):
  - the existing MCP `health` assertions move to the summary in this PR;
  - data-bearing results get envelope checks now, and bounded paging becomes a follow-up issue.
- Amended 2026-11-16, after a review on PR #53 found two defects. The owner approved both corrections:
  - **The summary was lossy.** It flattened variants into unions, so it listed unsupported modes and selectors as if they were usable. It also could not distinguish a build-disabled JPEG choice from an available one. The summary now keeps per-variant eligibility (see [Rules](#rules)).
  - **"Additive" was the wrong classification.** The change alters the documented MCP mapping of `details`. It is now recorded as a change to an unreleased entry point, made before its first release (see [Compatibility and version decision](#compatibility-and-version-decision)).
- Date: 2026-11-15
- Issue: #52 (part of #32; evidence from #35)
- Baseline: main `3b57d45f60fbdd0d10dcf7baeccd24da2c114c0d`, plus the #35 runner from PR #51 (`20464d48804f`). The implementation branch is stacked on `stack/qualify-35-schema-41`: #51 plus #50 (the #41 fix), and later main `27255b0`, all merged without edits. This lets Claude Code be qualified on the same head.

## Context

The MCP connector returns each `computer_use` result as `structuredContent`, which is the core `details`, and `content[0].text`, which is the same JSON pretty-printed. For discovery, `details` holds the full capabilities report. On the shared capability fixtures the compact `structuredContent` is:

| Fixture | `health` | `doctor` | `capabilitiesV1` | raw adapter `result` | `agent` |
|---|---|---|---|---|---|
| macOS (permission granted) | 43,762 B | 42,070 B | 25,133 B | 16,534 B | 1,262 B |
| X11 (`maim`) | 46,960 B | 45,268 B | 27,065 B | 17,840 B | 1,262 B |
| Wayland (unknown) | 55,509 B | 53,817 B | 31,325 B | 21,683 B | 1,262 B |

Three parts dominate:
- **`capabilitiesV1`.** 97% of it is `actions`. Each variant of each action repeats its full parameter limits and evidence.
- **The raw adapter envelope (`result`).** It carries the adapter's own `capabilitiesV1` a second time.
- **`agent`.** This is the OpenClaw agent profile, with its `~/.openclaw` paths. It means nothing to an MCP host.

The other observation-only results are small:

| Action | Size |
|---|---|
| `stop` | 382 B |
| `screenshot` | about 1.2 KB, plus the image block |
| `file-list` | about 200 B, plus entries |
| `file-read` | about 260 B, plus content |

### Measured harness budgets

`scripts/harness-qualification/measure-budget.mjs` bisects the largest `computer_use` result that reaches the model intact. Each probe is a full run of the real harness through `scripts/qualify-harness.mjs`, with a disposable home and the deterministic local endpoint. The connector is replaced by a size probe whose `structuredContent` is padded with real capability entries to an exact compact size. The resolution is 64 B.

macOS, arm64, 2026-11-15. Receipts are in [`docs/harness-qualification/budget/darwin-arm64/`](../harness-qualification/budget/darwin-arm64/).

| Harness | Model metadata | Largest intact | Smallest rejected | What the model got instead |
|---|---|---|---|---|
| Claude Code 2.1.325 | `claude-opus-5-5` (the harness default) | 49,984 B | 50,048 B | The result was stored in a file; the model got a 2,384-character preview |
| Codex CLI 0.169.0 | unknown slug (fallback model info) | **11,926 B** | 11,989 B | Truncated in the middle; the model got 12,020 characters |
| Codex CLI 0.169.0 | `gpt-5.5` (bundled catalog) | 47,944 B | 48,008 B | Truncated in the middle; the model got 48,020 characters |
| Copilot CLI 1.0.107, BYOK | `claude-sonnet-4` | 20,468 B | 20,532 B | Spilled to a session file; the model got a 921-character preview |
| Copilot CLI 1.0.107, BYOK vision | `claude-sonnet-4` | 20,468 B | 20,532 B | The same |

**All three harnesses budget the compact `structuredContent`, not the text.** The recorded bisection pretty-prints the text carrier the way the connector does, which makes it 1.8 times larger. The thresholds matched a compact-text run exactly, and the model always received exactly the compact size.

The Codex numbers follow from its source at `rust-v0.169.0`:
- A model without catalog metadata gets `TruncationPolicyConfig::bytes(10_000)` (`codex-rs/models-manager/src/model_info.rs`).
- Catalog models get `tokens(10_000)`.
- A user's `tool_output_token_limit` overrides both.

The observed limits are about 1.2 times those budgets.

### Consequences today

- The 43.9 KB macOS `health` fails L2 on Codex without catalog metadata, and on Copilot in every variant.
- It passes on Claude Code with 6 KB to spare.
- Every Wayland `health` and `doctor` result (53–56 KB) would exceed even Claude Code's 50 KB limit.

## Decision drivers

- **Every Tier A harness delivers every connector-shaped observation-only result intact,** with margin for the harness prefix, model metadata and fixture growth.
- **The model still learns, for each action:**
  - its availability state;
  - whether the action profile allows it;
  - whether it needs approval;
  - why it is degraded;
  - which mode, format, selector and provider combinations it can use, and why each of the others is unavailable.

  It also still receives the repair hints and the permission flow.
- **No v1 schema breaks.** The SDK, the plugin and OpenClaw qualification stay unchanged. The MCP mapping of `details` does change; see [Compatibility and version decision](#compatibility-and-version-decision).
- **The full report stays reachable,** and nothing becomes a second source of truth.
- **One focused PR,** with no request-contract change.

## Options considered

### A. Project a compact summary at the MCP surface; the full report stays with the SDK, plugin and CLI (recommended)

MCP `health` and `doctor` return `capabilitySummaryV1` in place of `capabilitiesV1`. The summary is a pure projection of the same report:
- the projection is computed in the MCP server;
- the core execution path, the SDK and the plugin keep returning the full report.

Every result fits the smallest measured budget with room to spare (see below).

### B. Option A plus per-action detail pages over MCP

A new optional request field, for example `{ "action": "doctor", "detail": "screenshot" }`, would return one action's full v1 entry. Each page fits the budget, and the pages together rebuild the full report without loss.

It needs a request-contract change:
- the generated contract assets change;
- the advertised input schema changes (PR #50 owns `src/mcp/schema.ts`);
- every harness shows the model a new field.

It is deferred until an MCP consumer needs the full report and cannot use the SDK.

### C. Summary on `health` only; `doctor` keeps the full report

`doctor` is observation-only and is just as large (42–54 KB). It would still be cut or spilled on Codex without catalog metadata and on Copilot, so this fails the first driver.

### D. Shrink `capabilitiesV1` itself

The v1 capabilities schema requires `variants[].limits.parameters`, `evidence` and `policy` on every action. A smaller report would need capabilities v2, and that changes every surface. An emptied `variants` or `parameters` list would also be read as "no variants" or "no limits", which is false.

### E. Tailor results by MCP client identity or `_meta`

Rejected:
- It is hidden behaviour.
- Harnesses do not send such metadata.
- A host that identified itself differently would get results it cannot deliver.

### F. Status quo, plus advice on harness settings

Codex users could raise `tool_output_token_limit` or use catalog models. Copilot has no setting for this, and default installs would stay broken.

## Decision: option A

### Result shape

This applies to MCP `health` and `doctor` only. A successful macOS `health` (abridged):

```json
{
  "status": "success", "success": true, "action": "health",
  "evidence": { "action": "health", "adapter": "/path/to/adapter" },
  "result": { "ok": true, "platform": "macos", "session": null },
  "healthCheck": { "tool": "computer_use", "args": { "action": "health" } },
  "capabilitySummaryV1": {
    "schemaVersion": 1,
    "producer": { "name": "opencoven-desktop-use", "version": "0.1.3", "surface": "mcp" },
    "environment": { "platform": "macos", "session": null },
    "adapter": { "version": "0.1.3" },
    "actionPermissions": { "profile": "observation-only", "allowedActions": ["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read"], "snapshotId": "…" },
    "actions": {
      "screenshot": {
        "state": "unverified", "enabled": false, "surfaces": ["cli", "mcp"],
        "policy": { "profile": "allowed", "approval": "request-dependent" },
        "reasonCodes": ["BACKEND_ACCESS_UNVERIFIED"],
        "variants": [
          { "modes": ["screen", "window", "frontmost"], "formats": ["png", "jpg"], "selectors": ["app", "windowTitle", "windowId"], "provider": "peekaboo", "state": "unverified", "enabled": false, "reasonCodes": ["BACKEND_ACCESS_UNVERIFIED"] },
          { "modes": ["screen"], "formats": ["png", "jpg"], "selectors": ["screenIndex"], "provider": "peekaboo", "state": "unverified", "enabled": false, "reasonCodes": ["BACKEND_ACCESS_UNVERIFIED"] }
        ]
      }
    },
    "omitted": { "capabilitiesV1": "tool-output-budget", "fullReportSurfaces": ["sdk", "plugin", "cli"] }
  },
  "adapterInvocation": { "configuredPath": "…", "resolvedPath": "…", "version": "0.1.3", "phase": "adapter", "processStarted": true },
  "repairHints": [],
  "actionPermissions": { "scope": "adapter-eligibility", "profile": "observation-only", "allowedActions": ["…"], "snapshotId": "…", "gatewayAuthorization": "not-reported" }
}
```

The MCP result changes in three ways:
- **Replaced:** `capabilitiesV1` becomes `capabilitySummaryV1`.
- **Removed:**
  - `result.capabilitiesV1`, the duplicate raw adapter report. The rest of the legacy envelope stays, including `setupGuide` and `code`.
  - `agent`, the OpenClaw agent profile.
- **Kept unchanged:** `status`, `success`, `code`, `error`, `reason`, `adapterProbe`, `adapterInvocation`, `repairHints`, `permissionFlow` and `actionPermissions`.

### Rules

- **The summary is a projection, never a second source.**
  - For each action, `state`, `surfaces`, `policy.profile`, `policy.approval` and `reasonCodes` are copied from the full report. v1 fixes `policy.gatewayPolicy` to `not-reported`, so the summary omits it.
  - `enabled`, for the action and for each variant, comes from the existing reference consumer, `discoverCapabilityControls`.
  - `variants` groups the report's variants. Two variants share an entry only if they are identical except for their capture mode. Each entry copies the variants' `modes`, `formats` (and `formatKnowledge` when stated), `selectors`, provider name, `state` and `reasonCodes`. So every mode, format, selector and provider stays tied to its own state, reasons and eligibility, and no union can make an unsupported choice look usable. Variant limits other than format, constraints and evidence are omitted.
  - An absent list means the report's list is empty.
  - The summary states no fact that the full report lacks. For every fixture, a test expands each entry back into one entry per mode and compares that set with the report's variants and the reference consumer's eligibility. A second test pins the `wayland-grim-jpeg-disabled` and `-enabled` pair: screen JPEG must read `unsupported` (`ENCODING_BUILD_DISABLED`) and `available` respectively, and only screen capture may be usable on that compositor.
- **The MCP text carrier becomes compact JSON** of `structuredContent`, for every MCP result. Clients that read the text instead of `structuredContent` then get the same budget. `JSON.parse(content[0].text)` still deep-equals `structuredContent`, so every existing parity check holds.
- **The budget is `MCP_RESULT_BUDGET_BYTES = 8192`** compact bytes, for both carriers. That is:
  - 69% of the smallest measured limit (Codex without catalog metadata, 11,926 B);
  - 40% of Copilot's limit;
  - 16% of Claude Code's limit.

  The largest projected result across all fixtures is 7,936 B: X11 `health` with missing helpers, which includes the setup guide and the permission flow. Successful discovery results are 4,569–7,936 B, and error and blocked results are 163–6,696 B. Before the projection, the same results were 13–56 KB. The first summary shape reached only 6,890 B, but it was lossy.
- **The budget covers connector-shaped results.** These are `health`, `doctor`, `stop` and `screenshot`, plus every `blocked`, `needsApproval` and `error` envelope. They must fit for every capability fixture on both MCP wire revisions.
- **Data-bearing results are sized by what was requested.** These are `inspect` UI trees, `file-list` entries (up to 500) and `file-read` content (up to 1 MiB). Their envelopes are tested with fixture data. Bounding or paging their data needs request fields, so it is a follow-up, not part of this decision.

### Compatibility and version decision

**This changes the documented MCP mapping of an entry point that has not been released yet. It lands before that entry point's first release. The execution contract stays v1.**

It is not additive. `desktopResultDetailsSchemaV1` requires only `status` and declares `capabilitiesV1` optional, so a result that has `capabilitySummaryV1` and no `capabilitiesV1` still validates. Optional-property validation does not preserve behaviour, though: a consumer that ran `discoverCapabilityControls(structuredContent.capabilitiesV1)` on MCP `health` would now fail. The documentation also promised that MCP maps `details` to `structuredContent` and preserves the SDK's content (`docs/desktop-client.md`, `docs/mcp.md`, `src/contracts.ts`).

Why that is acceptable under the version policy in `docs/desktop-client.md`:
- **No release contains the MCP entry point.** npm 0.1.3 does not contain the SDK or MCP exports; #30 prepares 0.1.4 as their first release. A breaking change to an existing *released* entry point would need a documented package release and migration. This change ships inside the first release of the entry point instead.
- **Schemas and identifiers are unchanged.** The capabilities v1 schema, the request schema, the canonical actions and the schema `$id`s stay as they are. `capabilitySummaryV1` is a new versioned object with its own `schemaVersion: 1` and a JSON Schema, `capabilitySummarySchemaV1`, exported from the contracts entry. It is an optional property of `desktopResultDetailsSchemaV1`. The schema is inline, so the build's asset list does not change.

What this PR does with it:
- **Amends the mapping promise wherever it is stated:**
  - `docs/desktop-client.md` and `docs/mcp.md` (one sentence each, owner-approved although #30 and #49 own those files);
  - the `src/contracts.ts` comment;
  - `docs/capabilities-contract.md`.
- **Migrates every in-repo MCP reader of `capabilitiesV1`:**
  - `src/mcp/connector.test.ts`;
  - `scripts/packed-wire-consumer.mjs`;
  - main's `scripts/packed-recipe-consumer.mjs`.

  #30's `scripts/release-installed-consumer.mjs` exists only on that branch. Its migration is posted on #30.
- **Migration for consumers:** read `structuredContent.capabilitySummaryV1` instead. Per-action and per-variant `enabled` are the eligibility that `discoverCapabilityControls` would return. A consumer that needs variant limits, constraints or evidence uses `createDesktopClient`, which is the same execution core and whose report differs only in `producer.surface`. Alternatively, it uses the plugin. The 0.1.4 release notes should state the projection (`CHANGELOG.md` is #30's).

### Unchanged

- The SDK (`createDesktopClient`) and the plugin (`createComputerUseTool`) still return `capabilitiesV1` and the raw envelope.
- OpenClaw qualification, CLI `doctor` and `help`, and the audit events.
- The capabilities v1 schema and the request schema.

## Implementation plan

1. `src/capability-summary.ts`: `summarizeCapabilities(report)`. `src/contracts.ts`: `capabilitySummarySchemaV1`, and an optional `capabilitySummaryV1` property in `desktopResultDetailsSchemaV1`.
2. `src/mcp/result-projection.ts`: `projectMcpResult(result)`. It applies the summary to `health` and `doctor`, and compact text to every result. `src/mcp/server.ts` uses it.
3. `src/mcp/result-budget.test.ts`, using the official SDK client on both wire revisions (pinned `2026-07-28` and legacy `2025-11-25`):
   - **Cases:**
     - every capability fixture;
     - a missing adapter;
     - an unknown schema major;
     - `doctor` denied by the profile;
     - macOS permission denied.
   - **Actions:** every observation-only action. Both carriers must be ≤ `MCP_RESULT_BUDGET_BYTES`.
   - **Checks:**
     - the summary, expanded per mode, equals the full report's variants with the reference consumer's eligibility;
     - the screen JPEG pair `wayland-grim-jpeg-disabled` / `-enabled` stays distinguishable;
     - MCP results carry no `capabilitiesV1`;
     - the SDK still does.
   - It fails on `main`, where `health` is 44–56 KB.
4. Existing assertions about MCP `health`. **These files are owned by open PRs, so they need an owner decision before they change:**
   - `src/mcp/connector.test.ts` (#30);
   - `scripts/packed-wire-consumer.mjs` (#49, #50);
   - `scripts/packed-recipe-consumer.mjs`, added to main by #55 after this ADR was first accepted.

   Each assertion keeps its strength and moves to the summary: `schemaVersion`, `producer.surface`, `actionPermissions`, and per-action `state`, `policy.profile` and `surfaces`. Each test also gains `capabilitiesV1 === undefined`. The full-report coverage stays on the SDK path, which `scripts/packed-sdk-consumer.mjs` already checks.
5. Docs:
   - `docs/capabilities-contract.md` (MCP discovery);
   - this ADR's status;
   - `docs/harness-qualification/README.md`;
   - the mapping sentence in `docs/desktop-client.md` and in `docs/mcp.md`.

   `README.md` and `CHANGELOG.md` are owned by #49 and #30, and follow once those merge.
6. Re-qualify Claude Code, Codex (both variants) and Copilot (both variants):
   - on macOS locally;
   - on Linux and hosted macOS through `.github/workflows/harness-qualification.yml`.

## Consequences

- MCP discovery fits every Tier A harness, so `health` can reach L2 on Codex without catalog metadata and on Copilot.
- An MCP model loses variant limits other than format, plus constraints and evidence detail.
  - The request schema already carries parameter limits, and execution enforces them.
  - Evidence detail is summarized as each variant's `state` and `reasonCodes`.
- MCP `structuredContent` is no longer a byte-for-byte copy of SDK `details` for discovery. The contract comment and docs must say so.
- Raising the budget, or adding a field to the summary, is a deliberate change: the budget test fails first.
- PR #30 changes every capability fixture. The budget test reads those fixtures, so #30 must stay within budget when it rebases. That is the point of the test.
