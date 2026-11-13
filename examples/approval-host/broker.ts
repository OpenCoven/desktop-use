import { createServer, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalResolution } from '../../src/core/client.js';
import { authentic, decisions, digest, exactKeys, frame, mac, privateDirectory, readRequest, type Review } from '../../src/mcp/broker-protocol.js';
import { requestContract } from '../../src/mcp/schema.js';

export async function startApprovalHost(options: { directory: string; secret: Buffer; prompt(review: Review, signal: AbortSignal): Promise<ApprovalResolution> }) {
  await privateDirectory(options.directory);
  if (options.secret.length !== 32) throw new Error('APPROVAL_UNAVAILABLE');
  const path = join(options.directory, 'approval.sock'); const sockets = new Set<Socket>(); const seen = new Set<string>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); const controller = new AbortController();
    socket.once('close', () => { sockets.delete(socket); controller.abort(); }); socket.on('error', () => controller.abort());
    // Authenticated requests may wait only until their bound expiry; unauthenticated peers get two seconds.
    let timer = setTimeout(() => socket.destroy(), 2000);
    void (async () => {
      try {
        const received = await readRequest(socket);
        if (!exactKeys(received, ['v', 'nonce', 'body', 'mac'])) return;
        const { mac: signature, ...request } = received;
        if (request.v !== 1 || typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(request.nonce) || !authentic(mac(options.secret, 'request', request), signature)) return;
        const review = request.body as Review;
        if (!review || typeof review.operationId !== 'string' || typeof review.approvalId !== 'string' || typeof review.target !== 'string' || !review.scope || typeof review.scope.principalId !== 'string' || !Number.isSafeInteger(review.expiresAt) || review.expiresAt > Date.now() + 300_000 || !review.policy) return;
        if ((await requestContract['~standard'].validate(review.params)).issues) return;
        if (seen.has(request.nonce) || seen.has(review.operationId) || seen.size >= 2048) return;
        seen.add(request.nonce); seen.add(review.operationId);
        clearTimeout(timer); timer = setTimeout(() => { controller.abort(); socket.destroy(); }, Math.max(1, review.expiresAt - Date.now()));
        let decision: ApprovalResolution = Date.now() >= review.expiresAt ? 'expired' : await options.prompt(review, controller.signal);
        if (!decisions.includes(decision)) decision = 'unavailable';
        if (controller.signal.aborted) return;
        if (Date.now() >= review.expiresAt) decision = 'expired';
        const response = { v: 1, nonce: request.nonce, digest: digest(request), decision };
        socket.end(frame({ ...response, mac: mac(options.secret, 'response', response) }));
      } catch { /* No raw protocol, provider, input or authentication diagnostics. */ }
      finally { clearTimeout(timer); if (!socket.writableEnded) socket.destroy(); }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve(); }); });
  await chmod(path, 0o600);
  return { socketPath: path, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await unlink(path).catch(() => {}); } };
}
