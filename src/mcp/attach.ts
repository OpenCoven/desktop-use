import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { privateSocket } from './broker-protocol.js';

/**
 * Harness-side byte relay to an operator-launched approver (ADR 0001).
 * It carries MCP messages only: no secret, configuration, approval decision or authority passes through it.
 * Resolves 0 when the harness ends the session and 1 when the approver is absent, refuses, drops or stops it.
 */
export async function runAttach(socketPath: string, io: { stdin: Readable; stdout: Writable } = { stdin: process.stdin, stdout: process.stdout }): Promise<number> {
  if (!isAbsolute(socketPath)) return 1;
  try { await privateSocket(socketPath); } catch { return 1; }
  return new Promise(resolve => {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    let connected = false; let inputEnded = false; let settled = false;
    const finish = (code: number) => { if (settled) return; settled = true; io.stdin.unpipe(socket); resolve(code); };
    socket.once('connect', () => {
      connected = true;
      io.stdin.once('end', () => { inputEnded = true; });
      io.stdin.pipe(socket);
      socket.pipe(io.stdout, { end: false });
      // The approver ends a session only when its connector is gone; never linger half-open.
      socket.once('end', () => { io.stdin.unpipe(socket); socket.end(); });
    });
    socket.once('error', () => { socket.destroy(); finish(1); });
    // Only the harness ends a session normally; a refused, dropped or stopped approver must fail visibly.
    socket.once('close', hadError => finish(!connected || hadError || !inputEnded ? 1 : 0));
    io.stdin.once('error', () => socket.destroy()); io.stdout.once('error', () => socket.destroy());
  });
}
