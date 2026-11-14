import { createReadStream } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ApprovalProvider, ApprovalResolution } from '../core/client.js';
import { authentic, decisions, digest, exactKeys, frame, mac, privateSocket, readFrame } from './broker-protocol.js';

async function readSecret(fd: number): Promise<Buffer> {
  if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('APPROVAL_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const stream = createReadStream('', { fd, autoClose: true, highWaterMark: 66 });
    let value = ''; let done = false;
    const finish = (secret?: Buffer) => { if (done) return; done = true; clearTimeout(timer); stream.destroy(); secret ? resolve(secret) : reject(new Error('APPROVAL_UNAVAILABLE')); };
    const timer = setTimeout(() => finish(), 2000);
    stream.on('error', () => finish());
    stream.on('data', chunk => { value += chunk.toString(); if (value.length > 65) finish(); });
    stream.on('end', () => finish(/^[a-f0-9]{64}\n$/.test(value) ? Buffer.from(value.trim(), 'hex') : undefined));
  });
}
/** The secret is consumed once from a host-inherited descriptor, never model input or an environment value. */
export async function createBrokerProvider(options: { socketPath: string; secretFd: number }): Promise<{ provider: ApprovalProvider; close(): void }> {
  const secret = await readSecret(options.secretFd); const sockets = new Set<Socket>(); let closed = false;
  const provider: ApprovalProvider = async challenge => {
    if (closed) return 'unavailable';
    if (challenge.signal.aborted) return 'cancelled';
    if (Date.now() >= challenge.expiresAt) return 'expired';
    let socket: Socket | undefined; let timer: NodeJS.Timeout | undefined;
    const abort = () => socket?.destroy();
    try {
      await privateSocket(options.socketPath);
      if (closed || challenge.signal.aborted) return 'cancelled';
      const { signal: _signal, ...body } = challenge;
      const request = { v: 1, nonce: randomBytes(32).toString('hex'), body };
      const encoded = frame({ ...request, mac: mac(secret, 'request', request) });
      socket = connect({ path: options.socketPath, allowHalfOpen: true }); sockets.add(socket);
      const response = readFrame(socket);
      challenge.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(1, challenge.expiresAt - Date.now()));
      socket.once('connect', () => socket!.write(encoded));
      const received = await response;
      if (!exactKeys(received, ['v', 'nonce', 'digest', 'decision', 'mac'])) return 'unavailable';
      const { mac: signature, ...signed } = received;
      if (signed.v !== 1 || signed.nonce !== request.nonce || signed.digest !== digest(request) || !decisions.includes(signed.decision) || !authentic(mac(secret, 'response', signed), signature)) return 'unavailable';
      return challenge.signal.aborted ? 'cancelled' : Date.now() >= challenge.expiresAt ? 'expired' : signed.decision as ApprovalResolution;
    } catch { return challenge.signal.aborted ? 'cancelled' : Date.now() >= challenge.expiresAt ? 'expired' : 'unavailable'; }
    finally { clearTimeout(timer); challenge.signal.removeEventListener('abort', abort); if (socket) { sockets.delete(socket); socket.destroy(); } }
  };
  return { provider, close() { closed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); secret.fill(0); } };
}
