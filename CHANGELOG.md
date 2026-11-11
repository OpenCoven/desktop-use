# Changelog

## Unreleased

- Validate requests before approval hooks and execution, including types, actions, enums, integer bounds, byte limits, and malformed argv.
- Preserve backend action errors, unsupported results, and confirmation requirements despite successful adapter process exits, with bounded observation retries.
- Audit structured execution failures and expose audit-write failures without replaying completed actions.
- Avoid echoing raw process exceptions and typed-input error diagnostics in adapter results.
- Run required checks on macOS and Linux in GitHub Actions, including real adapter fixture-process regressions.

- Added the dedicated OpenCoven `computer_use` agent boundary for OpenClaw with
  packaged identity/config templates.
- Added policy classification, approval gating, redacted audit logs, Control UI
  state metadata, plugin health, scoped host adapters, and transient observation
  retry behavior.
- Added focused TypeScript tests for policy, registration, tool execution,
  audit logging, agent metadata, and unsafe action denial.
- Thanks @BunsDev
