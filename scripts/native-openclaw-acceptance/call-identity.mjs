import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function nativeToolCallId(marker, action) {
  assert.match(marker, /^[a-z0-9-]{1,24}$/);
  assert.ok(action === 'capture' || action === 'click');
  // Preserve case identity within the pinned host's alphanumeric, 40-character limit.
  return `native21${createHash('sha256').update(marker).digest('hex').slice(0, 24)}${action}`;
}
