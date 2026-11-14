# Public delivery and installed acceptance

This is an implemented preparation path, not a claim of publication readiness. The current source remains version 0.1.4, the official frozen OpenClaw 2026.11.3 qualification is blocked by upstream trusted-workspace propagation, no successful full A workflow has been established, and B has not been selected. The ambiguity guard, frozen host lanes and successful-prior requirements remain mandatory. Resolve and requalify that dependency before delivery. Source changes invalidate prepared identities and require fresh builds and qualification.

## Producer and immutable evidence

`.github/workflows/release.yml` runs qualification for the feature branch and actual `v0.1.*` tag contexts. `workflow_dispatch` defaults to `delivery=prepare`. Branch pushes, tag pushes and prepare dispatches never publish. A tag must exactly equal the package version; all package/native artifacts and the manifest are freshly produced and attested under that actual tag ref. The public installer independently requires `refs/tags/v<VERSION>`, the full source digest, OpenCoven/desktop-use, `.github/workflows/release.yml`, SLSA v1 and GitHub-hosted runners. A branch manifest or attestation cannot satisfy it.

The producer's `release.json` is immutable and truthfully describes evidence available at assembly: build/native smoke passed, later gates not run. After all four install lanes and all twenty exact-host/profile lanes succeed, reconciliation copies the original bytes into a new delivery directory and creates `release-evidence.json`, `qualification-receipts.json`, release notes and a new external `SHA256SUMS`. The index binds the original manifest/package/native hashes and each exact lane receipt; no artifact embeds its own digest. The workflow separately attests the index, receipt bundle, checksums and notes. Receipts must match the current workflow run and attempt; use a complete new run when earlier-attempt artifacts remain. Later public download and graphical receipts supplement this snapshot; they never overwrite it or convert its publication status to passed.

A successful initial A candidate has no previous record and reports rollback not run. Only after the full actual same-repository A push workflow succeeds may the owner choose the next unused compatible B version and commit `qualification/release-previous.json`. The existing resolver verifies the successful run, source/ref, workflow and ancestry, and the installer independently verifies the old assets. A failed or partial A run cannot supply this input. B must execute actual A → B → A → B with package synchronization and native/SDK/MCP checks at every selection.

## Owner gates before external delivery

Refresh the exact source commit, ordinary CI, full qualification run, tag/npm version availability, protection, artifact hashes and actual approval scope. Retain the selected delivery artifact before authorizing a public operation. Merge must follow the repository PR and green-CI process. Tags are created only with explicit owner authority; this preparation did not create a tag or change main.

The delivery job requires a tag commit already contained in `origin/main` and actual owner authorization for the exact external operation. Preserve the repository's existing restrictions and approval process; this path does not require adding branch protection, an environment or a second reviewer, and it does not configure or weaken any existing protection. Its read-only preflight verifies the exact tag/source, qualification and immutable artifact evidence. No account, publisher permissions, credentials or signing material were inspected during preparation.

The npm trusted publisher must identify organization `OpenCoven`, repository `desktop-use` and workflow filename `release.yml`. This workflow does not select a GitHub environment. npm environment binding is optional; if the owner adopts it, the configured publisher environment and workflow job must match, with any existing environment restrictions preserved. An environment name does not itself establish publication authority or require a new independent-review process. The prepared path uses Node 24.22.0 and pinned npm 12.2.2, empty task-owned npm user/global configuration, no configured token fallback, and the exact already packed `.tgz`. It stages with explicit dist-tag `paired-candidate`, public access and provenance. It never repacks source, changes `latest`, configures a publisher or falls back to a token. Setup and any required allowed action remain owner gates. npm documents staged publication, interactive approval and immutable staged dist-tags in [npm stage](https://docs.npmjs.com/cli/v11/commands/npm-stage/), and workflow/environment matching in [trusted publishing](https://docs.npmjs.com/trusted-publishers/). Refresh those requirements at delivery time.

For the first 0.1.4 public pair only, `delivery=stage-bootstrap` is a separate explicit approval choice. It requires every A qualification lane passed, no previous qualification record, and rollback not run. It resolves the lack of a public A; it does not satisfy final rollback acceptance. `delivery=stage` requires completed actual A → B → A → B and the same remaining gates. Neither choice may be dispatched under preparation-only authority. Both perform external writes: npm staging followed by a GitHub prerelease containing the exact delivery assets. A tag-bound rebuild and later public B verification are additional work, even when candidate branch source/version match.

After an authorized staging job, a maintainer reviews and approves the exact npm stage using npm's interactive proof-of-presence process. Staging alone is not npm publication. The workflow retains `publication.json` with the npm-stage and GitHub-prerelease outcomes independently; it leaves public approval, downloads, installed acceptance and graphics not run. If either service fails, preserve the partial state and inspect its real version/stage/release before any retry. Do not overwrite assets, reject stages, change dist-tags or silently republish as an automatic repair. No publication command, including a dry run, was executed during implementation.

## Verify actual public bytes

Use a new disposable environment for each declared native runner, with Node 24.22.0, npm and a `gh` version supporting the mandatory attestation flags. Review the exact tag's source before running its scripts; install script dependencies with lifecycle scripts disabled. Keep `COVEN_HOME`, `OPENCLAW_STATE_DIR`, npm configuration/cache and output roots private and task-owned. Download the two real public versions with independently reviewed full source commits; do not fill these values from an unverified manifest or use branch artifacts.

```sh
node scripts/release-public.mjs "$public_a_version" "$public_a_commit" "$qualification_root/public-a"
node scripts/release-public.mjs "$public_b_version" "$public_b_commit" "$qualification_root/public-b"
```

The downloader fetches public GitHub assets and the exact public npm tarball, requires all GitHub attestations, validates the external checksum list, archives and pair identities, recomputes the evidence index, and requires the registry bytes and SHA-512 integrity to equal the attested package. A still-staged npm package fails this check. `public-download.json` records this evidence and explicitly leaves installation and graphics not run. npm provenance presence is recorded separately from its later cryptographic verification.

In a fresh consumer directory, install the exact registry version with lifecycle scripts disabled and verify npm signatures/provenance. Retain the registry metadata/integrity, lockfile, exact installed package tree checks and command result. An audit failure is a gate, not permission to skip provenance.

```sh
npm install --ignore-scripts --omit=dev --no-audit --no-fund "@opencoven/openclaw-desktop-use@$public_b_version"
npm audit signatures
```

Create an independently reviewed previous-public policy JSON with exactly `version`, `sourceCommit` and `sourceRef` for A; the ref must be `refs/tags/v<A_VERSION>`. Then run the existing installer qualifier against the downloaded directories. Supply B's reviewed source/tag in the environment and the actual declared runner label. The fourth argument selects the explicit public-prior policy; without it the candidate workflow's successful prior-run file remains mandatory.

```sh
GITHUB_SHA="$public_b_commit" GITHUB_REF="refs/tags/v$public_b_version" RELEASE_RUNNER="$actual_runner" node scripts/release-install.mjs "$qualification_root/public-b" "$qualification_root/public-install" "$qualification_root/public-a" "$qualification_root/previous-public.json"
```

This stages both tag-bound releases through the mandatory public verifier and executes A → B → A → B, reinstalls the selected packed package each time, verifies its complete installed file inventory, runs SDK/MCP consumers and selected native doctor, and records actual source/manifest/package identities. It guards against Rust use during installation. Inspect `installation.json` and selected executable paths; a shadowing Cargo binary is not the selected pair. No gateway restart or plugin configuration synchronization is implied.

Run each frozen host/profile lane against the downloaded public B assets using the actual runner label, `GITHUB_SHA` and `GITHUB_REF` above. Use `scripts/release-host.mjs ASSETS NEW_PRIVATE_ROOT HOST_VERSION PROFILE` for both frozen hosts and all five profiles on Ubuntu 22.04 AMD64 and macOS 15 ARM64. Public tag manifests use the public verifier; candidate manifests retain their separate trusted source policy. Preserve exact SDK resolution, installed package and gateway receipts. These synthetic backend lanes do not replace native graphics.

For an end user after the specific public version is verified, install that pinned package and invoke the explicit installer with downloaded, verified assets and an absolute private root. Package installation has no postinstall native download.

```sh
npm install --ignore-scripts --omit=dev "@opencoven/openclaw-desktop-use@$public_version"
./node_modules/.bin/coven-desktop-use-install stage --version "$public_version" --root "$absolute_private_root" --manifest "$download_directory/release.json" --assets "$download_directory"
./node_modules/.bin/coven-desktop-use-install activate --version "$public_version" --root "$absolute_private_root"
```

Use the returned absolute adapter path in the intended host configuration, inspect health/doctor and actual selected package version, and obtain separate authority before any live gateway restart. Activation is not atomic with package/host synchronization. A retained earlier version can be selected with the explicit `rollback` operation, but that does not undo desktop effects, helper installation or privacy grants.

## Installed graphical handoff

Record a sanitized receipt for each declared native installation and required graphical session. Use #21's disposable fixture and preserve unrelated applications, active sessions and existing grants. Obtain the exact helper installation, app interaction and privacy-grant authority before performing those actions; do not infer it from permission to prepare or publish a release.

| Evidence | Required observed identity and result |
| --- | --- |
| Public pair | Public URLs, exact version/full source/tag, downloaded package/native/manifest SHA-256, successful mandatory verifier output and npm integrity/provenance result |
| Installed selection | Canonical adapter path and runtime `--version`, package path/version/hash, current selection, shadowing paths and synchronization outcome |
| Native host | Actual hardware architecture, OS build, Rust-free install receipt, libc/kernel where relevant, declared floor versus actual observed execution |
| Helpers and session | Exact Peekaboo/X11/Wayland helper paths/versions, compositor/session and fixture app identity, daemon/uinput prerequisites where applicable |
| Permissions | Observed Screen Recording/Accessibility or Linux session/input access, grant identity and exact approval scope; unknown remains unknown |
| Display and capture | Display identity, dimensions, origin/scale/mixed-display topology, actual screenshot receipt/hash and verified visual content in the disposable fixture |
| Input and targeting | Approved click/type/key/scroll/focus, selectors/coordinate mapping, observed fixture effect, denied/unsupported outcomes and no broadening/replay |
| Consumers and recovery | Public installed plugin/SDK/MCP, full/restricted profiles, approvals/denials/expiry, Stop, actual public A → B → A → B and truthful partial synchronization |
| Limits | Signing/notarization, untested OS/display/session combinations, missing native or human acceptance, and evidence class for every claim |

Keep raw captures, app titles, clipboard/file contents, gateway configuration, histories and tokens private. Publish only allowlisted categorical results, digests and sanitized fixture evidence. Each receipt needs status `passed`, `failed` or `not-run`, exact pair/session identity, observed result and evidence reference. Unknown prerequisites and unsupported effects remain explicit. Only propose #25 closure after public availability, all declared native installations, required host/consumer behavior, actual rollback and installed graphical evidence meet the original issue acceptance.
