import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertPackedMetadata } from './packed-metadata.mjs';

const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
test('packed metadata accepts only the known optional pnpm prepack removal', () => {
  assertPackedMetadata(source, structuredClone(source));
  const pnpmPacked = structuredClone(source); delete pnpmPacked.scripts.prepack;
  assertPackedMetadata(source, pnpmPacked);
});
for (const mutation of ['version', 'dependencies', 'script-change', 'script-removal', 'script-addition', 'prepack-change', 'all-scripts', 'new-field']) test(`packed metadata rejects unrelated ${mutation} mutation even after pnpm prepack removal`, () => {
  const packed = structuredClone(source); delete packed.scripts.prepack;
  if (mutation === 'version') packed.version = '999.0.0';
  if (mutation === 'dependencies') packed.dependencies.ajv = '0.0.1';
  if (mutation === 'script-change') packed.scripts.build = 'echo fake';
  if (mutation === 'script-removal') delete packed.scripts.check;
  if (mutation === 'script-addition') packed.scripts.extra = 'echo fake';
  if (mutation === 'prepack-change') packed.scripts.prepack = 'echo fake';
  if (mutation === 'all-scripts') delete packed.scripts;
  if (mutation === 'new-field') packed.extra = true;
  assert.throws(() => assertPackedMetadata(source, packed), /Packed package metadata differs/);
});
