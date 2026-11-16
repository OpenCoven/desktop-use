#!/usr/bin/env node
// Measures a harness's tool-output budget (#52): bisects the size of a structured MCP result that the harness still
// delivers to the model intact, using qualify-harness.mjs in size-probe mode.
//
//   node scripts/harness-qualification/measure-budget.mjs --harness <id> [--variant <name>] [--bin <path>]
//                                                         [--low 1024] [--high 262144] [--resolution 64] [--text compact|pretty]
//                                                         [--out <file>]
//
// "Intact" means the model received structured content that parses and is at least the probe size. Sizes are compact
// JSON bytes of structuredContent. `--text pretty` pretty-prints content[0].text (the connector's own form), which
// shows whether a harness forwards structuredContent or the text. Every probe run is a full real-harness run with a
// disposable home and the deterministic local endpoint.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const runner = fileURLToPath(new URL('../qualify-harness.mjs', import.meta.url));
const { values: options } = parseArgs({ options: { harness: { type: 'string' }, variant: { type: 'string', default: 'default' }, bin: { type: 'string' }, low: { type: 'string', default: '1024' }, high: { type: 'string', default: '262144' }, resolution: { type: 'string', default: '64' }, text: { type: 'string', default: 'compact' }, out: { type: 'string' } }, strict: true });
if (!options.harness) { process.stderr.write('usage: measure-budget.mjs --harness <id> [--variant <name>] [--bin <path>] [--low n] [--high n] [--resolution n] [--text compact|pretty] [--out file]\n'); process.exit(64); }
const scratch = await mkdtemp(join(tmpdir(), 'desktopuse-budget-'));
const runs = [];
let receiptHeader = null;

async function probe(bytes) {
  const out = join(scratch, `${bytes}.json`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    spawnSync(process.execPath, [runner, '--harness', options.harness, '--variant', options.variant, ...(options.bin ? ['--bin', options.bin] : []), '--probe-bytes', String(bytes), '--probe-text', options.text, '--out', out, '--timeout', '120'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const receipt = JSON.parse(await readFile(out, 'utf8').catch(() => 'null'));
    const health = receipt?.observation?.health;
    if (!receipt || receipt.levels?.L1?.verdict !== 'pass' || !health?.resultSeen) continue; // not observed: retry once
    receiptHeader ??= { harness: receipt.harness, host: receipt.host };
    const intact = health.structuredContent === 'delivered' && health.textChars >= bytes;
    const run = { bytes, intact, modelSawChars: health.textChars, transformation: intact ? null : health.transformation ?? health.structuredContent, carrier: health.structuredCarrier ?? null };
    runs.push(run);
    process.stderr.write(`${options.harness}${options.variant === 'default' ? '' : ` (${options.variant})`} ${bytes} B: ${intact ? 'intact' : `${run.transformation}, model saw ${run.modelSawChars} chars`}\n`);
    return run;
  }
  throw new Error(`No observable run at ${bytes} bytes`);
}

let low = Number(options.low), high = Number(options.high);
const resolution = Number(options.resolution);
let summary;
try {
  const first = await probe(low);
  if (!first.intact) summary = { budget: 'below-low', low };
  else {
    const top = await probe(high);
    if (top.intact) summary = { budget: 'at-least-high', high };
    else {
      while (high - low > resolution) {
        const mid = Math.round((low + high) / 2);
        if ((await probe(mid)).intact) low = mid; else high = mid;
      }
      const rejected = runs.find(run => run.bytes === high);
      summary = { largestIntactBytes: low, smallestRejectedBytes: high, rejectedAs: rejected.transformation, modelSawCharsWhenRejected: rejected.modelSawChars, resolutionBytes: resolution };
    }
  }
} finally { await rm(scratch, { recursive: true, force: true }); }

const result = { schemaVersion: 1, kind: 'harness-tool-output-budget', recordedAt: new Date().toISOString(), probe: { structuredContent: 'compact JSON padded with real capability action entries', text: options.text === 'pretty' ? 'the same JSON, pretty-printed' : 'the same compact JSON' }, ...receiptHeader, ...summary, runs: runs.sort((a, b) => a.bytes - b.bytes) };
const text = JSON.stringify(result, null, 2) + '\n';
if (options.out) await writeFile(options.out, text); else process.stdout.write(text);
