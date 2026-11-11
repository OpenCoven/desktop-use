# Platform capability evidence

Initial inventory: 2026-11-10, origin/main `8db9aa1fa2b70c38d8b48fad46f9c896805c2b87`. REST `/issues?state=open` returned zero items (including PRs); `/pulls?state=all` returned only merged PRs #2–#6. No reliability PR or remote reliability branch exists. Local `fix/tool-reliability` and `fix/reliability-delivery` both point to main; the former worktree is missing/prunable. Neither branch is taken over. Goal 1 delivery is unproven; this fresh branch implements the required gaps directly from main.

Legend: I = implemented in source; T = deterministic test evidence; D = degraded; U = unsupported; V = real graphical acceptance unverified. Tests are not graphical acceptance.

## Baseline matrix (before this change)

| Capability | macOS | Linux X11 | Linux Wayland | Windows |
| --- | --- | --- | --- | --- |
| doctor/health | I, V; Peekaboo permissions | I, V; tool paths only | I, V; tool paths overstate compositor readiness | U desktop; plugin host health exists |
| inspect | I, V | I, D, V; image only | I, D, V; image only | U |
| screenshot | I, V | I, V; failed window lookup silently captures screen | I, D, V; ignores window mode | U |
| click | I, V | I, V; coordinates only | I, V; ydotool, daemon unchecked | U |
| typing | I, V | I, V | I, V; always prefers installed wtype | U |
| keypress | I, V | I, V | I, V; wtype only | U |
| scroll | I, V | I, V | I, D, V; page/arrow keys via wtype | U |
| focus | I, V | I, V | I, V; Sway only; selector validation absent | U |
| clipboard | I, V | U | U | U |
| browser/app launch | I, V | U | U | U |
| file operations | I; lexical checks only | I; same plugin | I; same plugin | Plugin-only I; desktop U |
| approval | T; interactive adapter --confirm plus plugin policy | T; same | T; same | Plugin policy only |
| timeout | Plugin timeout only; helper unbounded | Same | Same | Desktop U |
| cancellation | stop acknowledges only, active calls continue | Same | Same | Desktop U |
| audit/privacy | T for basic redaction; diagnostics echo argv/stderr; audit failure hidden | Same | Same | Plugin-only |

Baseline `pnpm run check`: 20 TypeScript tests and 14 Rust tests passed; runtime import guard passed. No repository CI workflow or required branch checks exist at inventory; only GitHub dynamic analysis workflows are registered. A PR test workflow will be added without altering protection.

## Acceptance gates

The current host is macOS. `command -v peekaboo` found no helper. No helper installation or privacy changes are authorized. Adapter graphical actions require Peekaboo and existing Screen Recording/Accessibility grants; these remain unverified until available. Linux X11, Wayland compositor protocols/ydotool permissions, and Windows runtime are not available in this environment. Windows remains explicitly unsupported. Disposable helper processes and workspace files can verify execution and privacy contracts locally, but cannot close these graphical gates.

## Reliability dependency discovered during execution

PR #7 was created at 2026-11-11T01:39:48Z after the initial inventory. Its head `71d539308ad7358a8b648e745fa7daf0272202ed` is green and unmerged. Runtime PR #8 is rebased onto `fix/reliability-delivery`, preserving request validation, JSON outcome handling, audit-failure outcome preservation, tests, and the existing CI workflow. No commits or ownership on #7 are changed. Linux coverage will depend on #8. Existing timeout tests are updated to prove a shared deadline without replay after budget exhaustion.
