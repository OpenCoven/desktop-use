// Sizing helpers for harness tool-output budget probes (#52). No I/O beyond reading the shared capability fixture.
import { readFileSync } from 'node:fs';

const { report } = JSON.parse(readFileSync(new URL('../../contracts/v1/fixtures/capabilities/x11-maim.json', import.meta.url), 'utf8'));
const entries = Object.entries(report.actions).map(([action, entry]) => ({ action, ...entry }));

// Structured content whose compact JSON is exactly `bytes` long. Padding is made of real capability action entries,
// so harnesses that budget in tokens see realistic JSON rather than a run of one character.
export function sizedResult(action, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 256) throw new RangeError('A probe result needs at least 256 bytes');
  const value = { status: 'success', success: true, action, probe: { targetBytes: bytes }, padding: [], fill: '' };
  const size = () => Buffer.byteLength(JSON.stringify(value));
  for (let i = 0; size() < bytes; i++) {
    value.padding.push(entries[i % entries.length]);
    if (size() > bytes) { value.padding.pop(); break; }
  }
  value.fill = 'f'.repeat(Math.max(0, bytes - size()));
  if (size() !== bytes) throw new Error(`Cannot size the probe result to ${bytes} bytes`);
  return value;
}
