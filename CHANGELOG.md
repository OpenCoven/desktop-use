# Changelog

## 0.1.4 - preparation candidate

- Add the compiled standalone SDK, shared public v1 execution contracts and local MCP connector with trusted approval boundaries.
- Prepare source-bound paired package/native release qualification and explicit installation without claiming publication, successful first-A qualification or rollback acceptance.
- Replace the unpublished first-A candidate with 0.1.4; the separately published 0.1.3 artifact remains immutable.

## 0.1.3 - 2026-11-13

- Deliver validated PNG/JPEG image blocks with content hashes and explicit capture/coordinate metadata; reject stale or malformed image artifacts and report unavailable geometry honestly.
- Add trusted action eligibility profiles and canonical action allowlists, with permission-aware schemas, health probes, alias parity, and an always-available scoped Stop.
- Advertise only implemented Stop and health controls, document every panel field's producer, and qualify the packaged plugin's policy, approvals, cancellation, and redacted audits through the minimum supported OpenClaw gateway on macOS and Linux.

- Name `computer_use` in the Linux setup guide, tag the deprecated `desktop_use` alias as approval-gated, and keep the packaged agent template and docs in step with the plugin.
- Deprecate the plugin tool `desktop_use` in favor of `computer_use`, the action inputs `permissions -> doctor`, `see -> inspect`, `capture -> screenshot`, `type -> type-text`, and `press -> keypress`, and the `clipboard-write` field `text` in favor of `clipboardText`. Removal is targeted at **0.2.0**. Legacy inputs remain accepted for this compatibility release and add a `deprecation` string naming replacements to results without changing status, approval, or audit behavior. Prefer the 18 canonical actions while retaining the five deprecated aliases in the bounded 23-value enum for host validation; retain `desktop_use` registration and `openclaw.plugin.json` contracts until the later release.

- Bound helper sequences with shared deadlines, process-group cleanup, scoped cancellation, failure stopping, and private diagnostics.
- Resolve workspace file paths before approval, including relative traversal and static symlink escapes; summarize durable audit values and require explicit content return.
- Report Linux capabilities from helper/protocol evidence, reject unsupported targeting, validate Sway replies, and select honest Wayland input/scroll/capture fallbacks.
- Add approved, bounded Linux clipboard and browser/app launch integrations with explicit unsupported responses and graphical acceptance gates.
- Define the tool names once and share one scope key between the approval hook and Stop; a call without a session key no longer shares a scope with a session keyed `"default"` or `""`.

- Validate requests before approval hooks and execution, including types, actions, enums, integer bounds, byte limits, and malformed argv.
- Preserve backend action errors, unsupported results, and confirmation requirements despite successful adapter process exits, with bounded observation retries.
- Audit structured execution failures and expose audit-write failures without replaying completed actions.
- Avoid echoing raw process exceptions and typed-input error diagnostics in adapter results.
- Run required checks on macOS and Linux in GitHub Actions, including real adapter fixture-process regressions.

- Added the dedicated OpenCoven `computer_use` agent boundary for OpenClaw with packaged identity/config templates.
- Added policy classification, approval gating, redacted audit logs, Control UI state metadata, plugin health, scoped host adapters, and transient observation retry behavior.
- Added focused TypeScript tests for policy, registration, tool execution, audit logging, agent metadata, and unsafe action denial.
- Thanks @BunsDev
