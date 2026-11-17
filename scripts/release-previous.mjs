#!/usr/bin/env node
/** Resolve committed prior-candidate qualification input against GitHub's actual run. */
import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
let previous;
try { previous = JSON.parse(await readFile('qualification/release-previous.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  assert.deepEqual(Object.keys(previous).sort(), ['runId', 'sourceCommit', 'sourceRef', 'version']);
  assert.match(previous.runId, /^[0-9]+$/);
  assert.match(previous.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(previous.sourceRef, /^refs\/heads\/[A-Za-z0-9_./-]+$/);
  assert.match(previous.version, /^0\.1\.[0-9]+$/);
  const run = JSON.parse(execFileSync('gh', ['api', `repos/OpenCoven/desktop-use/actions/runs/${previous.runId}`], { encoding: 'utf8' }));
  assert.equal(run.repository.full_name, 'OpenCoven/desktop-use');
  assert.equal(run.head_repository.full_name, 'OpenCoven/desktop-use');
  assert.equal(run.head_sha, previous.sourceCommit);
  assert.equal(`refs/heads/${run.head_branch}`, previous.sourceRef);
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.event, 'push');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  execFileSync('git', ['merge-base', '--is-ancestor', previous.sourceCommit, process.env.GITHUB_SHA]);
  await appendFile(process.env.GITHUB_OUTPUT, `runId=${previous.runId}\nsourceCommit=${previous.sourceCommit}\n`);
} else await appendFile(process.env.GITHUB_OUTPUT, 'runId=\nsourceCommit=\n');
