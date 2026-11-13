# Explicit paired releases

Release `0.1.3` is a preparation candidate, not a published or attested release. A package build, fixture verifier test, hosted native build, publisher attestation, installed host qualification, publication and graphical acceptance are separate evidence classes. The installer refuses an unavailable or unverified public release. Existing npm `0.1.2` does not establish these SDK/MCP exports. No npm lifecycle hook downloads the native adapter or installs desktop helpers.

## Public installation, update and rollback

Prerequisites are Node 22.14 or newer and an independently installed GitHub CLI whose `gh attestation verify --help` supports `--source-digest`, `--source-ref`, `--signer-workflow`, `--deny-self-hosted-runners` and JSON output. Network access to GitHub and the verifier's trust services is required. Install/configure the verifier yourself; the installer never installs it, inspects credentials or falls back to checksum-only acceptance. A verifier failure is a failed install.

Download `release.json`, the exact package tarball and your native tarball from the intended release into a private directory. The manifest pins their asset names; the public command takes an explicit version, not `latest`. Use an absolute private install root with an existing parent. The directory and its contents must belong to the current account and exclude group/other access.

```sh
coven-desktop-use-install stage --version 0.1.3 --manifest /absolute/downloads/release.json --assets /absolute/downloads --root /absolute/private/desktop-use
coven-desktop-use-install activate --version 0.1.3 --root /absolute/private/desktop-use
```

The executable is packaged at `scripts/install-adapter.mjs` and may also be invoked with Node from a trusted checkout. It is administrator tooling, not a model-facing tool. `stage` performs no selection change. It snapshots the manifest and both archives, verifies all three publisher attestations, checks bytes/hashes/entries, extracts into private staging, checks package exports and identity, verifies the native file architecture, and runs the staged binary's JSON `--version`. A source/version/protocol/contract/target mismatch fails before activation. Shell text or `--version --json` output is not the native contract.

`activate` re-verifies the retained attestations, assets, extracted contents and executable identity, then atomically replaces only `<root>/active.json`. It prints the exact `adapterPath`, verified package tarball path, and `hostSynchronization: "pending"`. The pair lives in `<root>/versions/0.1.3`; files and directories are made read-only, and an existing version is never overwritten. This protects against accidental edits, not a hostile process running as the same account. Keep the private root and the installed verifier/Node environment trusted.

Plugin installation and binary configuration are separate external operations. Use the exact `packagePath` printed by activation with `openclaw plugins install /absolute/path/to/package.tgz --force`. For standalone consumers, use `npm install --ignore-scripts /absolute/path/to/package.tgz` in the intended project. Extraction itself does not install JavaScript dependencies or register a host plugin. The installer neither edits gateway configuration nor restarts a running host, changes PATH, grants privacy permissions or installs Peekaboo/Linux helpers. A package-install or host-reload failure after local activation leaves `hostSynchronization` pending; there is no cross-package transaction.

Discovery remains explicit environment override, then `~/.cargo/bin/coven-desktop-use` when present, then PATH. A Cargo binary therefore shadows a newer PATH binary. Activation reports the actual configured/resolved path and JSON version in the installer's account/environment, and prints a shell-quoted command with the verified absolute binary path:

```sh
COVEN_DESKTOP_USE_BIN='/absolute/private/desktop-use/versions/0.1.3/native/coven-desktop-use' openclaw gateway
```

Apply that path deliberately to the actual gateway service's launcher environment; a terminal command does not change a previously running service. The SDK uses its trusted `adapterPath` option; MCP uses trusted configuration `adapterPath`. Their exact values are included in the installer result. Confirm the host's own health response reports the intended path/version after your explicit package/configuration/reload steps. The installer can report an unparseable old binary version as `null`, never as a verified version.

To update, stage the next explicit version and then activate it using the same commands. Previous version directories and receipts remain intact. To roll back, explicitly select a retained version:

```sh
coven-desktop-use-install rollback --version 0.1.3 --root /absolute/private/desktop-use
```

Rollback revalidates that retained pair and updates local selection; reinstall its retained package and restore its explicit path in each affected host yourself. It does not undo desktop effects, files written by desktop actions, grants, helper installations or running-process state. `previousVersion` records the immediately preceding local selection, not a complete host deployment history.

## Interruptions and partial failures

An error reports a fixed error code plus the completed phase and private staging directory when applicable. A failed stage stays under `versions/.stage-*` for inspection and never becomes active. A published stage may exist even if the final directory durability check failed. An activation failure before rename preserves the previous `active.json`; failure after rename reports `selectionChanged: true` and unknown durability. No automatic retry replays a host action.

An interrupted process can leave `.install-lock` or `.selection-next`. Stop all installer processes for this root, inspect `active.json`, retained receipts and staging directories, and remove only those stale private lock/temporary entries before retrying the explicit command. Do not infer a running host's state from local selection. Retained versions should not be edited to repair an interrupted stage. Manual cleanup of a read-only failed stage requires first restoring owner write permission inside that specific private stage.

## Producer contract for Task 2

`ReleaseManifestV1` is defined by `contracts/v1/release.schema.json`. `validateReleaseManifest(value)` returns a recursively frozen snapshot or the fixed `RELEASE_MANIFEST_INVALID` error. Schema 1 accepts only protocol 1 and observation/capabilities/canonical-actions contract 1. All package surfaces are the same `@opencoven/openclaw-desktop-use` artifact at the same release version and full source commit. It rejects unknown properties, targets, duplicate assets/paths, version/source/protocol disagreement and unsupported evidence states. Supported qualification targets are `aarch64-apple-darwin` on macOS 15, `x86_64-apple-darwin` on macOS 15 Intel, `x86_64-unknown-linux-gnu` on Ubuntu 22.04 and `aarch64-unknown-linux-gnu` on Ubuntu 22.04 ARM. Linux requires glibc 2.35 and kernel 5.15 or newer; other distributions, musl and Windows are not claimed. A selected target must match the actual installer process architecture and host floor.

Commit source before building. Every package build recomputes `dist/release-identity.json` from Git. Cargo's build script deliberately reruns on every build and derives the native source identity from Git rather than a cached/environment-supplied commit stamp. The native JSON `--version` retains `ok` and `version`, adding `schemaVersion`, `releaseVersion`, `source: {repository, commit, dirty}`, `adapterProtocolVersion`, `contracts` and the actual Rust `TARGET`. The package identity has the same fields except `ok`, `version` and `target`. Unknown source is `null`; a dirty or unknown source is rejected by release pairing. There is no self-referential source commit. Build artifacts after the final source commit; do not edit source to insert its own commit hash.

On each actual target runner, build from that same clean commit with the frozen lockfile and capture the actual binary's `--version` envelope. Each native gzip archive must contain exactly two regular files: executable `coven-desktop-use` and nonexecutable `release-identity.json` containing that captured envelope. Use a ustar producer, not a default PAX producer:

```sh
cargo build --release --locked --target "$release_target"
cp "target/$release_target/release/coven-desktop-use" "$native_stage/coven-desktop-use"
"$native_stage/coven-desktop-use" --version > "$native_stage/release-identity.json"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$native_asset" -C "$native_stage" coven-desktop-use release-identity.json
pnpm pack --out "$package_asset"
```

Run the native capture only on its compatible actual runner. The package tarball must have the normal `package/` prefix and its real package/plugin metadata, compiled plugin/SDK/contracts/MCP files and generated identity. The parser permits bounded regular files/directories only, rejects all symlinks/hardlinks/devices/PAX/GNU extensions, and rejects unsafe names, set-id modes, duplicate names, checksum failures and file/directory conflicts. Archives are limited to 64 MiB compressed, 128 MiB decompressed and 2,048 regular entries. Current package paths fit ustar; a future longer package path must be resolved deliberately rather than weakening archive checks.

Create a policy JSON with these fields: `schemaVersion: 1`, `releaseVersion`, `source: {repository: "OpenCoven/desktop-use", commit: FULL_SHA, tag, ref, workflow: ".github/workflows/release.yml"}`, `adapterProtocolVersion: 1`, `contracts: {observation: 1, capabilities: 1, canonicalActions: 1}`, `package: {name: "@opencoven/openclaw-desktop-use", version, sourceCommit: FULL_SHA, adapterProtocolVersion: 1, surfaces: ["plugin", "sdk", "mcp"], asset}`, and `artifacts: [{target, asset, minimumOsVersion, signing: {status, url}, libc?}]`. macOS `minimumOsVersion` is `15.0`; Linux is `22.04` with `libc: {family: "glibc", minimumVersion: "2.35"}`. Signing is `not-run` with `url: null` until actual evidence exists; attestation does not imply Apple signing/notarization.

Include `qualifiedHosts` as exact records `{version, integrity, status, evidenceUrl}` for OpenClaw `2026.4.26` and/or `2026.11.3`, using actual frozen npm `sha512-...` integrity and each lane's evidence. An empty array claims no host qualification. Include independent `evidence` keys `build`, `nativeSmoke`, `cleanInstall`, `hostedGateway`, `publication`, `graphicalAcceptance`, each `{status: "passed" | "failed" | "not-run", urls: []}`. A passed/failed status needs evidence URLs; not-run needs none. Candidate publication must be not-run. These are producer claims and links, not substitute verification.

```sh
node scripts/release-manifest.mjs policy.json /absolute/artifact-directory /absolute/output/release.json
```

Assembly reads actual archive bytes and identities, computes `bytes`, SHA-256 and every file entry's path/size/hash/executable flag, and validates the resulting immutable contract. Supplied stale derived fields are recomputed. It writes the manifest plus an external `.sha256` file without overwriting either. The manifest never contains its own digest. Attest the manifest and each package/native archive with the fixed `.github/workflows/release.yml` workflow, SLSA v1, GitHub-hosted runners, exact source digest/ref and repository `OpenCoven/desktop-use`. The installer always invokes the real `gh attestation verify` with those restrictions. There is no checksum fallback, custom cryptographic verifier, runtime verifier callback or public bypass flag.

## Candidate versus public provenance

A public manifest uses `source.tag: "v0.1.3"` and `source.ref: "refs/tags/v0.1.3"`. The public CLI independently derives that ref from its required version and rejects a candidate manifest. Candidate manifests use `tag: null`, the actual `refs/heads/...` or `refs/pull/<number>/merge` source ref, and publication not-run. They do not claim that a tag exists.

Trusted Task 2 CI code can import `stageCandidateRelease(options, {sourceCommit, sourceRef})` and `activateCandidateRelease(options, {sourceCommit, sourceRef})` from `scripts/install-adapter.mjs`. Obtain that policy from the job's trusted checkout context, independently of the manifest; use the actual full source SHA and ref of the attestation producer. Options are `{version, root, manifest, assets, target?}` for staging and `{version, root, operation?}` for selection; `operation: "rollback"` labels an explicit retained candidate selection. Both use the real fixed GitHub verifier and reject a manifest not matching the supplied source policy. There is no candidate CLI option. Candidate receipts are marked `candidate: true`, cannot be activated by the public CLI, and remain qualification evidence until the separately authorized public workflow attests tag-bound artifacts.

Unit tests place a deliberately fake `gh` on a child process's private PATH and compile harmless version-only native fixtures. Their receipts are fixture behavior evidence only, never proof of an actual signature, hosted runner, native backend, installed gateway or public release. Task 2 must supply and verify real attestations and actual four-runner installation/update/rollback and host qualification receipts.

## Delivery preparation

The tag-aware producer, immutable evidence reconciliation, explicitly gated npm staging/GitHub prerelease path, public download verification and installed native acceptance handoff are documented in [public delivery and installed acceptance](release-delivery.md). The current 0.1.3 source remains blocked by official newer-host qualification; this implementation does not establish publication readiness or #25 completion.
