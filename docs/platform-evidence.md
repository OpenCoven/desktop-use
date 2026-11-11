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

## Delivered capability matrix

All T entries refer to deterministic tests in this branch; V means graphical acceptance remains unverified. Tool availability and protocol advertisement are prerequisites, never proof of a rendered desktop action. Windows desktop commands and host clipboard/launch remain unsupported; platform-neutral plugin file/policy/audit code is implemented but has no Windows runtime acceptance.

| Capability | macOS | Linux X11 | Linux Wayland | Windows |
| --- | --- | --- | --- | --- |
| doctor/health | I/T; real doctor ENOENT, Peekaboo absent | I/T/V; inventory and capability states | I/T/V; registry probe, tool prerequisites, daemon access unverified | U desktop |
| inspect | I/T/V; Peekaboo JSON validated | I/T/D/V; screenshot, no AT-SPI ids | I/T/D/V; screenshot only when capture provider can run | U |
| screenshot | I/T/V | I/T/V; scrot or maim; safe argv, failed window lookup stops; nonempty artifact required | I/T/V; grim uses wlr-screencopy or the ext capture/source pair with unverified installed-helper compatibility; targeted modes U | U |
| click | I/T/V | I/T/V; coordinates, unsupported selectors rejected | I/T/V; ydotool; daemon/uinput unverified | U |
| typing | I/T/V; literal flag-like text protected | I/T/V; xdotool argv, failure stops clear/type/return | I/T/V; protocol-aware wtype or ASCII ydotool, no automatic resend | U |
| keypress | I/T/V | I/T/V | I/T/V; wtype chords or common evdev fallback, unsupported keys stop before input | U |
| scroll | I/T/V | I/T/V; wheel buttons, invalid direction rejected | I/T/V; ydotool wheel; wtype page/arrow fallback D | U |
| focus | I/T/V | I/T/V; wmctrl/xdotool | I/T/V on Sway only; injection rejected, IPC JSON validated; other compositors U | U |
| clipboard | I/T/V; pbcopy/pbpaste | I/T/V; xclip/xsel | I/T/V; native wl-copy/wl-paste only | U |
| browser launch | I/T and observed in Dia | I/T/V; xdg-open handoff | I/T/V; xdg-open handoff | U |
| app launch | I/T and observed disposable AppKit window | I/T/V; gtk-launch desktop id | I/T/V; gtk-launch desktop id | U |
| file operations | I/T; relative and static symlink escapes require approval | I/T; same plugin; no Linux GUI implication | I/T; same plugin | Plugin implementation only, Windows runtime V |
| approval | I/T; existing hook and adapter confirm preserved | I/T; same | I/T; same | Plugin policy only |
| timeout | I/T; shared deadline, limits, owned-group termination | I/T in local/hosted helper tests | I/T in fixtures, compositor V | Desktop U |
| cancellation | I/T; stop across instances, gateway AbortSignal, 250 ms escalation | I/T in helper tests, GUI V | I/T in fixtures, GUI V | Desktop U |
| audit/privacy | I/T; summarized request values, no implicit content previews, failures visible | I/T; platform-independent policy/audit | I/T; platform-independent policy/audit | Plugin implementation only, Windows runtime V |

## Observed macOS graphical evidence

The plugin's built-in browser-open action launched http://127.0.0.1:48739/ from a disposable local server. CUA observed the selected Dia tab titled Desktop Use Goal 2 Disposable Probe, and its screenshot visibly showed Receipt: goal2-local-browser-20261110. The command receipt alone was not used as graphical proof.

The plugin's built-in app-launch action launched a disposable AppKit .app built only from a small local Swift test source. CUA observed its window titled Desktop Use Goal 2 Disposable App and accessibility text Receipt: goal2-local-app-20261110. The fixture app is not installed as a system helper. Owned fixture app/server processes are cleaned up after verification. The clipboard and unrelated user desktop content were not changed.

The real built adapter doctor returned `ok:false`, `code:ENOENT`, `backend:peekaboo`. No Peekaboo binary was found on PATH. Screenshot/inspect/input/focus through Peekaboo remain unavailable for acceptance under the prohibition on installing system helpers or changing privacy grants. CUA observation of the launch receipts does not substitute for adapter screenshot/input evidence. Linux X11, Wayland, and Windows graphical sessions are unavailable; their runtime gates remain open.

## Independent review and disposition

One independent read-only review found screenshot output option injection (critical), silently ignored Linux target selectors (important), and an invalid X11 scroll direction default (minor). Each was reproduced with a failing fixture test and fixed; the whole suite then passed. Screenshot output now follows an explicit option terminator, unsupported selectors cause zero helper invocations, and invalid directions return errors. A further failing regression covered flag-like Peekaboo typing text and was corrected with a positional delimiter. The reviewer did not claim desktop acceptance or rerun the suite; local verification is recorded separately.

Deferred environmental gates retain their full criteria: run doctor plus screenshot/inspect, coordinate click, typing/clear/return, keypress/chords, wheel/page scrolling, exact window focus, clipboard roundtrip with disposable content, launch/rendered-window observations, cancellation and privacy checks in an actual X11 session and in each available Wayland compositor. For ydotool verify daemon/uinput and layout behavior; for wtype/grim verify the advertised protocols. On macOS install/grant Peekaboo only in a separately authorized run, then repeat the same disposable workflow. Windows remains unsupported rather than being claimed complete from fixtures.

## Upstream tool contracts consulted

[wtype source](https://github.com/atx/wtype/blob/master/main.c) defines the virtual-keyboard registry and literal argv delimiter. [ydotool manual](https://github.com/ReimuNotMoe/ydotool/blob/master/manpage/ydotool.1.scd), [typing implementation](https://github.com/ReimuNotMoe/ydotool/blob/master/Client/tool_type.c), and [wheel implementation](https://github.com/ReimuNotMoe/ydotool/blob/master/Client/tool_mousemove.c) establish daemon requirements, ASCII/layout limitations, literal-escape control, and wheel argv. [wl-clipboard manual](https://github.com/bugaevc/wl-clipboard/blob/master/data/wl-clipboard.1) documents stdin and background selection ownership. [Sway command conventions](https://github.com/swaywm/sway/blob/master/sway/sway.5.scd) require treating compositor IPC as command syntax despite shell-free argv. These references guide fixtures; they do not prove installed-helper compatibility.

Local delivery validation: `pnpm run check` passed with 75 TypeScript tests, 39 Rust unit tests, and one Rust CLI cancellation integration test. One ignored unit-test entry is explicitly invoked by parent fixture tests, not an omitted acceptance test. Typecheck, plugin-runtime import guard, cargo formatting, and `git diff --check` passed. Hosted candidate results are recorded in the final handoff after PR creation.

## Hosted delivery and handoff

Runtime PR [#8](https://github.com/OpenCoven/desktop-use/pull/8) at `48e4037fc1ed7184286596aec474ecc6860a869a` passed macOS/Linux [run 42941119545](https://github.com/OpenCoven/desktop-use/actions/runs/42941119545). It depends on the original owner's reliability PR [#7](https://github.com/OpenCoven/desktop-use/pull/7), head `71d539308ad7358a8b648e745fa7daf0272202ed`. Platform PR [#9](https://github.com/OpenCoven/desktop-use/pull/9), code candidate `cd4eb37c208024b6de8cb78594a27a396dced2d6`, passed macOS/Linux [run 42943013378](https://github.com/OpenCoven/desktop-use/actions/runs/42943013378) and depends on #8. The final documentation head and its CI receipts are retained in the local durable handoff; the tested code tree is unchanged by that documentation commit.

The initial open issue/PR inventory was empty. PR #7 appeared during execution and was retained as the explicit prerequisite; #8 and #9 are this goal's scoped deliveries. There are no standalone open issues at closeout. All PRs remain open; no merge, release, branch-protection change, or cleanup of another session's worktree was performed. Native/graphical gaps retain their full acceptance criteria above. The task worktree stays at /tmp/desktopuse-platform-completeness on feat/linux-capabilities, and durable receipts are retained in /Users/buns/Documents/GitHub/OpenCoven/desktop-use-goal2-evidence/handoff.md.

Final audit correction: compositor names without a successful registry probe leave capabilities unverified. A regression reproduced the previous false unsupported result, and the correction preserves unknown protocol availability instead of guessing from GNOME/KDE labels. The revised full local suite passes 75 TypeScript and 40 Rust tests (39 unit, one integration).

Final privacy regression: typed-input results retain only validated outcome flags, counters, fixed codes, and known backend names. Arbitrary nested diagnostic fields are discarded before returning results, including injected-runner errors; the previously leaking fixture failed before the correction.

Dependency refresh: #7 advanced to e4c025ef4e46e145aad31278b624d6370c580c62 through an automated string-redaction fix during final closeout. Runtime #8 now includes that commit at cd6dc6f (exact head in the durable handoff). Platform #9 retains the stricter safe-outcome allowlist, which already suppresses primitive strings and arbitrary fields. The refreshed stack preserves upstream ancestry without removing its protection, and both local suites and exact-head hosted CI are rechecked before delivery.
