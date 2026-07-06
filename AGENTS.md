# AGENTS.md — desktop-use

Guidance for **AI agents** (Codex, Claude Code, and any Coven familiar) opening
pull requests against this repo. Humans: your canonical guide is
[`CONTRIBUTING.md`](CONTRIBUTING.md) — this is the agent-specific layer on top.

> **Read first:** [`README.md`](README.md) for what this repo is, and
> [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contribution bar.

---

## What this repo is (one line)

`coven-desktop-use` is a small **external desktop-use adapter** for OpenClaw and
the Coven ecosystem (TypeScript with a Rust component). Keep it a thin adapter.

## Branch & PR workflow (all agents)

- **Never push to `main`.** Every change lands via a PR with green CI. Branch
  from current `origin/main`.
- **Fresh branch per task**; use a worktree if multiple sessions may touch this
  repo:
  ```sh
  git fetch origin main
  git worktree add -b <branch> /tmp/desktopuse-<branch> origin/main
  ```
- Keep the diff scoped to one concern; conventional-commit subjects (`feat:`,
  `fix:`, `docs:`, `chore:`, `refactor:`).
- After merge: delete the remote branch, remove your local worktree/branch.

## Checks — run locally before opening the PR

```sh
pnpm run check      # typecheck + tsx tests + plugin-runtime-import guard + cargo test
```

Or individually: `pnpm run typecheck`, `pnpm run test:ts`, `cargo test`. Fix
failures rather than skipping them.

## Repo-specific invariants (don't break these)

- This is an **adapter**, not the agent runtime. Don't pull OpenClaw/Coven core
  logic in here; keep the desktop-use surface thin and well-typed.
- Keep the plugin-runtime import boundary intact — `check:plugin-runtime-imports`
  exists to enforce it and will fail the PR if you cross it.

## Attribution — credit contributors correctly

When you re-land or build on someone else's work (a fork PR, an issue author's
proposal, a co-author), **credit the human contributor with a working
GitHub-linked trailer** so they appear in the contributors graph:

```
Co-authored-by: Full Name <ID+username@users.noreply.github.com>
```

- Use the **numeric-id no-reply form**. Get the id with `gh api users/<login> --jq .id`.
- **Never** use a machine or `.local` email in a co-author trailer — it links to
  no account and gives **zero** credit.
- When a squash-merge folds a contributor's PR into an internal branch, preserve
  their `Co-authored-by:` line in the squash commit message.
- Credit **people**, not AI tools.

## Secrets & safety

- Never commit secrets, tokens, or private emails. Use `*.noreply.github.com`
  for attribution.
- Don't disable CI gates or branch protection to land a change; surface the
  blocker instead.

## Claude Code

`CLAUDE.md` points here — this file is the source of truth for both.
