import { randomBytes } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { ReadStream, WriteStream, isatty } from 'node:tty';
import type { ApprovalResolution } from '../../src/core/client.js';
import type { Review } from '../../src/mcp/broker-protocol.js';

/** Ephemeral operator display only. Never log a review or echo private challenge identifiers. */
export function terminalPrompt() {
  let input: ReadStream | undefined; let output: WriteStream | undefined; let busy = false;
  try {
    const fd = openSync('/dev/tty', 'r+');
    if (!isatty(fd)) { closeSync(fd); throw new Error(); }
    input = new ReadStream(fd); output = new WriteStream(openSync('/dev/tty', 'w'));
    input.on('error', () => {}); output.on('error', () => {}); input.pause();
  } catch { input?.destroy(); output?.destroy(); input = undefined; output = undefined; process.stderr.write('Approval UI unavailable; gated operations will not execute.\n'); }
  return {
    async prompt(review: Review, signal: AbortSignal): Promise<ApprovalResolution> {
      if (!input || !output || input.destroyed || output.destroyed || busy || signal.aborted) return 'unavailable';
      const display = JSON.stringify({ target: review.target, effect: review.params, policy: review.policy, scope: review.scope, workspaceDir: review.workspaceDir, expiresAt: new Date(review.expiresAt).toISOString() }, null, 2).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
      if (Buffer.byteLength(display) > 16_384) { output.write('Approval unavailable: complete review exceeds terminal display limit. Nothing approved.\n'); return 'unavailable'; }
      busy = true;
      const reviewCode = randomBytes(4).toString('hex');
      return new Promise(resolve => {
        let line = ''; let done = false;
        const finish = (decision: ApprovalResolution) => { if (done) return; done = true; busy = false; input!.pause(); input!.removeListener('data', data); input!.removeListener('end', unavailable); input!.removeListener('error', unavailable); signal.removeEventListener('abort', cancelled); output!.write(`\nApproval ${decision}.\n`); resolve(decision); };
        const unavailable = () => finish('unavailable'); const cancelled = () => finish('cancelled');
        const data = (chunk: Buffer | string) => {
          line += chunk.toString();
          if (Buffer.byteLength(line) > 32) return finish('unavailable');
          if (!line.includes('\n')) return;
          // Exactly one decision; pasted extra lines cannot authorize a later prompt.
          const choice = line.trim();
          finish(choice === `allow ${reviewCode}` ? 'allowed' : choice === `deny ${reviewCode}` ? 'denied' : choice === `cancel ${reviewCode}` ? 'cancelled' : 'unavailable');
        };
        input!.on('data', data); input!.once('end', unavailable); input!.once('error', unavailable); signal.addEventListener('abort', cancelled, { once: true });
        output!.write(`\nReview canonical desktop operation (may have irreversible effects):\n${display}\nEnter a decision followed by this review code, for example: deny ${reviewCode}\nDecision [allow/deny/cancel] ${reviewCode}: `);
        input!.resume(); if (signal.aborted) cancelled();
      });
    },
    close() { input?.destroy(); output?.destroy(); }
  };
}
