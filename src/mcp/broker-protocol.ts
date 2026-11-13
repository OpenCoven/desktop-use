import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Socket } from 'node:net';
import type { ApprovalChallenge, ApprovalResolution } from '../core/client.js';

export const MAX_BROKER_BYTES = 1_048_576;
export type Review = Omit<ApprovalChallenge, 'signal'>;
export const decisions: readonly ApprovalResolution[] = ['allowed', 'denied', 'cancelled', 'expired', 'unavailable'];
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mac = (secret: Buffer, direction: 'request' | 'response', value: unknown) => createHmac('sha256', secret).update(direction + '\n' + JSON.stringify(value)).digest('hex');
export function authentic(expected: string, actual: unknown): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
export async function privateDirectory(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path) || await realpath(path) !== path) throw new Error('APPROVAL_UNAVAILABLE');
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('APPROVAL_UNAVAILABLE');
}
export async function privateSocket(path: string): Promise<void> {
  await privateDirectory(dirname(path));
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error('APPROVAL_UNAVAILABLE');
}
/** Exactly one bounded JSON frame, followed by EOF. Never accept a prefix of a repeated response. */
export function readFrame(socket: Socket): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error('APPROVAL_UNAVAILABLE')); } };
    socket.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BROKER_BYTES) { fail(); socket.destroy(); } else chunks.push(chunk); });
    socket.once('error', fail); socket.once('close', fail);
    socket.once('end', () => { if (settled) return; settled = true; try { resolve(parseFrame(Buffer.concat(chunks))); } catch { reject(new Error('APPROVAL_UNAVAILABLE')); } });
  });
}
export function frame(value: unknown): string {
  const encoded = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(encoded) > MAX_BROKER_BYTES) throw new Error('APPROVAL_UNAVAILABLE');
  return encoded;
}
export function exactKeys(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}

/** Keep the request half open so disconnect can cancel a pending prompt immediately. */
export function readRequest(socket: Socket): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0); let received = false;
    const fail = () => { reject(new Error('APPROVAL_UNAVAILABLE')); socket.destroy(); };
    socket.on('error', fail); socket.once('end', fail); socket.once('close', () => reject(new Error('APPROVAL_UNAVAILABLE')));
    socket.on('data', (chunk: Buffer) => {
      if (received) return fail();
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BROKER_BYTES) return fail();
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) return fail();
      received = true;
      try { resolve(parseFrame(buffer)); } catch { fail(); }
    });
  });
}

function parseFrame(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const value: unknown = JSON.parse(text);
  // The private protocol is canonical JSON plus LF: reject duplicate keys, invalid UTF-8 and extra frames.
  if (text !== frame(value)) throw new Error('APPROVAL_UNAVAILABLE');
  return value;
}
