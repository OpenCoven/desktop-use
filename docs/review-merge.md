# Review resolution and merge acceptance

The user authorized review resolution and merge of PRs #7, #8, and #9. This supersedes the earlier no-merge boundary; no release is authorized.

## Copilot review 5852779972 on PR #7

| Finding | Resolution and evidence |
| --- | --- |
| Failed shell diagnostics bypass sanitizer | Failed executions reach the shared safe error boundary; real fixture emits private stdout/stderr and exits nonzero without exposing either |
| Health exceptions expose raw messages | Health uses the same safe error conversion; result and audit regression excludes a private marker |
| Nested Peekaboo stdout mistaken for action success | One shared decoder handles transport and legacy/current backend envelopes for classification and retry; Rust validates backend JSON success independently of process exit |
| Prototype fields bypass validation | Own enumerable fields are copied to a prototype-free record; inherited action/approval and sparse key arrays are rejected or ignored |
| Required action argv validated after approval | Required desktop and host arguments are validated in normalizeParams before the execution policy and approval hook |
| Primitive-string diagnostic redaction | Safe outcome allowlisting removes arbitrary text while retaining validated flags, counters and fixed semantic codes |

The automated own-property edit also introduced a syntax error. Typecheck reproduced it; the conditional was restored before the regression suite. PR #7 passed 79 TypeScript and 16 Rust tests, macOS/Linux CI, Rust/TypeScript analysis, and the CodeQL summary. Every open inline finding received a concrete fix reply and was resolved; the review-only preapproval finding received a separate summary reply.

## Independent review of the complete stack

The reviewer identified three important gaps and two smaller gaps. Each was reproduced before correction. Explicit capture destinations now require canonical file-write approval. Text reads reject special files and cap allocation at 1 MiB; lists enumerate at most 501 entries to return 500 plus a truncation flag; writes stage content privately and check cancellation before atomic publication. General shell effects are no longer inferred from a denylist: arbitrary command execution requires runtime approval. These changes keep general authorization in the host runtime and the adapter boundary small.

Linux focus now combines supported selectors, treats app identifiers and title fragments literally, and rejects missing or ambiguous X11 inventory matches. Compositor command strings are serialized and escaped. Doctor propagates cancellation/deadline exhaustion after optional protocol probing. Captures use fresh private staging artifacts and publish atomically, so a stale destination cannot turn an empty helper run into success. Peekaboo positional queries and key names use an argv terminator. All corresponding helper-process and filesystem regressions pass.

The final local stack check passes 108 TypeScript tests, 49 Rust unit tests, and one real CLI cancellation integration test. The ignored Rust unit entry is an isolated fixture dispatcher explicitly invoked by parent tests. Typecheck, runtime-import guard, cargo formatting, and diff whitespace checks pass. Exact candidate heads, CI receipts, thread snapshots, and merge SHAs are retained in /Users/buns/Documents/GitHub/OpenCoven/desktop-use-goal2-evidence/review-merge.

## Acceptance limits retained

No fixtures are treated as real graphical acceptance. The previous disposable macOS browser and native-app launch observations remain valid evidence for those host integrations. Peekaboo is absent and Linux graphical sessions are unavailable, so screenshot/input/compositor/layout/clipboard acceptance stays unverified. Windows desktop use stays unsupported. Runtime approval now uses one-use private state unlocked by the public gateway resolution callback; confirm:true supplies no authority. Atomic filesystem confinement against hostile concurrent directory replacement remains an OS boundary; the adapter does not claim to replace it. Stop does not undo completed effects or interrupt a filesystem syscall already in progress. No code review finding is silently deferred.

## Additional Copilot conversations on #8 and #9

A missing timeout value is rejected before input dispatch. Canonical targets are resolved in the real approval hook using the authenticated tool-factory workspace and carried as exact paths; execution clears confirmation if a previously approved parent resolves elsewhere. Missing-ancestor reconstruction uses path.relative instead of separator slicing. During timeout/cancellation, the bounded cleanup window continues collecting the adapter report and retains only validated step counters; progressUnknown explicitly marks missing reports.

Already-addressed stale capture and cancelled doctor probe findings have direct regressions. Ydotool-only input no longer probes an irrelevant wtype protocol, and screenshot encoding follows the requested format independently of the destination suffix. These new regressions failed before correction and the complete suite passes afterward. The approval-hook tests use actual temporary symlinks and the same factory/hook context flow as the installed host API.
