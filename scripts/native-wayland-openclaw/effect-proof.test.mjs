import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { proveTextEffect } from './effect-proof.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const marker = 'provider-approved-42';
const fresh = () => ({ fixtureIdentity: 'a'.repeat(64), entryFocused: true, textLength: 0, textSha256: hash(''), keyCount: 0, clickCount: 0, scrollOffset: 0 });
function sample(decision = 'allow') {
  const before = fresh();
  const after = { ...before, ...(decision === 'allow' ? { textLength: marker.length, textSha256: hash(marker), keyCount: marker.length } : {}) };
  return { before, after, text: marker, decision };
}

test('one allowed marker proves only the exact reported focused-entry transition', () => {
  const proof = proveTextEffect(sample());
  assert.deepEqual(proof, { schemaVersion: 1, decision: 'allow', charactersAdded: marker.length, keyEventsAdded: marker.length, finalTextLength: marker.length, textSha256: hash(marker), unrelatedControlsUnchanged: true });
  assert.ok(!JSON.stringify(proof).includes(marker));
  assert.equal(Object.hasOwn(proof, 'actualProviderRequest'), false);
  assert.equal(Object.hasOwn(proof, 'nativeExecuted'), false);
});
for (const decision of ['deny', 'capture-only']) test(`${decision} requires unchanged reported controls`, () => {
  const proof = proveTextEffect(sample(decision));
  assert.equal(proof.charactersAdded, 0);
  assert.equal(proof.keyEventsAdded, 0);
  assert.equal(proof.finalTextLength, 0);
});
test('capture-only permits an existing text value but emits no raw fields', () => {
  const s = sample('capture-only');
  Object.assign(s.before, { textLength: marker.length, textSha256: hash(marker), keyCount: marker.length, rawPrivateText: marker });
  s.after = { ...s.before };
  const proof = proveTextEffect(s);
  assert.equal(proof.charactersAdded, 0);
  assert.equal(proof.finalTextLength, marker.length);
  assert.ok(!JSON.stringify(proof).includes(marker));
  assert.equal(Object.hasOwn(proof, 'rawPrivateText'), false);
});
for (const variant of ['wrong-length', 'wrong-hash', 'wrong-key-count', 'click', 'scroll', 'identity', 'focus-before', 'focus-after', 'nonempty-initial', 'initial-keys', 'initial-clicks', 'initial-scroll', 'invalid-empty-hash']) test(`allow rejects ${variant}`, () => {
  const s = sample();
  if (variant === 'wrong-length') s.after.textLength++;
  if (variant === 'wrong-hash') s.after.textSha256 = hash('other');
  if (variant === 'wrong-key-count') s.after.keyCount++;
  if (variant === 'click') s.after.clickCount++;
  if (variant === 'scroll') s.after.scrollOffset = .5;
  if (variant === 'identity') s.after.fixtureIdentity = 'b'.repeat(64);
  if (variant === 'focus-before') s.before.entryFocused = false;
  if (variant === 'focus-after') s.after.entryFocused = false;
  if (variant === 'nonempty-initial') Object.assign(s.before, { textLength: 1, textSha256: hash('a') });
  if (variant === 'initial-keys') s.before.keyCount = 1;
  if (variant === 'initial-clicks') { s.before.clickCount = 1; s.after.clickCount = 1; }
  if (variant === 'initial-scroll') { s.before.scrollOffset = 1; s.after.scrollOffset = 1; }
  if (variant === 'invalid-empty-hash') s.before.textSha256 = hash('not-empty');
  assert.throws(() => proveTextEffect(s));
});
for (const decision of ['deny', 'capture-only']) for (const variant of ['length', 'hash', 'keys', 'clicks', 'scroll', 'identity', 'focus']) test(`${decision} rejects changed ${variant}`, () => {
  const s = sample(decision);
  if (variant === 'length') s.after.textLength++;
  if (variant === 'hash') s.after.textSha256 = hash('other');
  if (variant === 'keys') s.after.keyCount++;
  if (variant === 'clicks') s.after.clickCount++;
  if (variant === 'scroll') s.after.scrollOffset++;
  if (variant === 'identity') s.after.fixtureIdentity = 'b'.repeat(64);
  if (variant === 'focus') s.after.entryFocused = false;
  assert.throws(() => proveTextEffect(s));
});
for (const value of [-1, .5, NaN, Infinity, '1', true, 1_000_001]) test(`rejects malformed key count ${String(value)}`, () => {
  const s = sample(); s.after.keyCount = value;
  assert.throws(() => proveTextEffect(s));
});
for (const text of ['', 'UPPER', 'emoji-😀', 'x'.repeat(65), "');process.exit(0);//"]) test(`rejects out-of-lane marker ${text.length}`, () => {
  const s = sample(); s.text = text;
  assert.throws(() => proveTextEffect(s));
});
for (const variant of ['bad-hash', 'bad-identity', 'bad-focus', 'missing-before', 'array-after', 'model-decision', 'nonempty-denial']) test(`rejects malformed or invalid prerequisite ${variant}`, () => {
  const s = sample(variant === 'nonempty-denial' ? 'deny' : 'allow');
  if (variant === 'bad-hash') s.after.textSha256 = 'private-input';
  if (variant === 'bad-identity') s.before.fixtureIdentity = 'private-identity';
  if (variant === 'bad-focus') s.after.entryFocused = 'true';
  if (variant === 'missing-before') s.before = null;
  if (variant === 'array-after') s.after = [];
  if (variant === 'model-decision') s.decision = 'confirm:true';
  if (variant === 'nonempty-denial') { Object.assign(s.before, { textLength: 1, textSha256: hash('a') }); s.after = { ...s.before }; }
  assert.throws(() => proveTextEffect(s));
});

test('unvalidated focus fields cannot echo private values through assertion diagnostics', () => {
  const s = sample(); s.after.entryFocused = marker;
  assert.throws(() => proveTextEffect(s), error => {
    assert.equal(JSON.stringify(error).includes(marker), false);
    assert.equal(String(error).includes(marker), false);
    return true;
  });
});
