import assert from 'node:assert/strict';

/** pnpm pack may remove prepack; every other manifest field must match exactly. */
export function assertPackedMetadata(source, packed) {
  const expected = structuredClone(source);
  if (expected.scripts && packed.scripts && !Object.hasOwn(packed.scripts, 'prepack')) delete expected.scripts.prepack;
  assert.deepEqual(expected, packed, 'Packed package metadata differs');
}
