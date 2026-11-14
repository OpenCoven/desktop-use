import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { nativeToolCallId } from './call-identity.mjs';

const host = process.env.NATIVE_OPENCLAW_HOST;
assert.ok(host, 'Select the official host for replay characterization');
const { r: sanitize } = await import(pathToFileURL(join(host, 'dist/tool-call-id-CYE4DX47.js')));

for (const marker of ['allowed','allowed-after','forged-confirm-denied','denied-after']) {
  for (const action of ['capture','click']) test(`exact ${marker}/${action} binding survives official strict replay`, () => {
    const id = nativeToolCallId(marker, action);
    const result = sanitize([{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'computer_use', arguments: {} }] }, { role: 'toolResult', toolCallId: id, content: [] }], 'strict');
    assert.equal(result[0].content[0].id, id);
    assert.equal(result[1].toolCallId, id);
    assert.match(id, /^[A-Za-z0-9]{1,40}$/);
  });
}

test('case punctuation and action cannot collide in emitted call identities', () => {
  const ids = [nativeToolCallId('allowed-after','capture'), nativeToolCallId('allowedafter','capture'), nativeToolCallId('allowed-after','click')];
  assert.equal(new Set(ids).size, 3);
  assert.throws(() => nativeToolCallId('x'.repeat(25),'capture'));
  assert.throws(() => nativeToolCallId('allowed','unknown'));
  assert.throws(() => nativeToolCallId('../private','capture'));
});

test('all case identities remain unique across one replayed session', () => {
  const ids = ['allowed','allowed-after','forged-confirm-denied','denied-after','x'.repeat(24)].flatMap(marker => ['capture','click'].map(action => nativeToolCallId(marker, action)));
  assert.equal(new Set(ids).size, 10);
  const transcript = ids.flatMap(id => [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'computer_use', arguments: {} }] }, { role: 'toolResult', toolCallId: id, content: [] }]);
  const result = sanitize(transcript, 'strict');
  assert.deepEqual(result.filter(message => message.role === 'toolResult').map(message => message.toolCallId), ids);
});
