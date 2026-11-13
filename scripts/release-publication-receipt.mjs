#!/usr/bin/env node
/** Outcome projection only; never infer public npm visibility from successful staging. */
import { writeFile } from 'node:fs/promises';
const outcome = value => ['success', 'failure', 'cancelled', 'skipped'].includes(value) ? value : 'unknown';
await writeFile(process.argv[2], JSON.stringify({
  schemaVersion: 1,
  sourceCommit: process.env.GITHUB_SHA,
  sourceRef: process.env.GITHUB_REF,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  npmStage: outcome(process.env.NPM_STAGE_OUTCOME),
  githubPrerelease: outcome(process.env.GITHUB_RELEASE_OUTCOME),
  npmPublicApproval: 'not-run',
  publicDownloadVerification: 'not-run',
  installedPublicPair: 'not-run',
  graphicalAcceptance: 'not-run',
  recovery: 'Inspect actual registry stage and release state before retrying; versions and staged dist-tags are immutable.',
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
