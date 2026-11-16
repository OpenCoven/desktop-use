#!/usr/bin/env node
// Markdown summary of harness qualification receipts: node scripts/harness-qualification/summarize.mjs <dir|file>...
// Every receipt is re-checked before it is summarized, so an inconsistent receipt fails here instead of being listed.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertReceipt } from './verdict.mjs';

const files = [];
for (const arg of process.argv.slice(2)) {
  if ((await stat(arg)).isDirectory()) for (const name of (await readdir(arg)).sort()) { if (name.endsWith('.json')) files.push(join(arg, name)); }
  else files.push(arg);
}
if (!files.length) { process.stderr.write('usage: summarize.mjs <receipt dir or files>\n'); process.exit(64); }
const level = result => result ? `${result.verdict}${result.reason ? ` (${result.reason})` : ''}` : '';
const rows = ['| Harness | Variant | Version | Connector | OS | Display | Discovery | L1 | L2 | Health result | Screenshot result | Image |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
for (const file of files) {
  const receipt = assertReceipt(JSON.parse(await readFile(file, 'utf8')));
  const { health, screenshot } = receipt.observation ?? {};
  const shown = seen => seen?.resultSeen ? `${seen.structuredContent}${seen.structuredCarrier ? `, ${seen.structuredCarrier}` : ''}${seen.transformation ? `, ${seen.transformation}` : ''}` : '';
  const image = screenshot?.image ? `${screenshot.image.handling}${screenshot.image.textPlaceholder ? ' (placeholder text)' : ''}` : '';
  const connector = receipt.connector ? receipt.connector.commit ?? (receipt.connector.tarballSha256 ? `tarball ${receipt.connector.tarballSha256.slice(0, 12)}` : receipt.connector.source) : '';
  rows.push(`| ${receipt.harness.label ?? receipt.harness.id} | ${receipt.harness.variant} | ${receipt.harness.version ?? ''} | ${connector} | ${receipt.host.os} ${receipt.host.arch ?? ''} | ${receipt.host.displayServer} | ${receipt.discovery?.mode ?? ''} | ${level(receipt.levels.L1)} | ${level(receipt.levels.L2)} | ${shown(health)} | ${shown(screenshot)} | ${image} |`);
}
process.stdout.write(rows.join('\n') + '\n');
