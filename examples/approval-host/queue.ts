import type { ApprovalResolution } from '../../src/core/client.js';
import type { Review } from '../../src/mcp/broker-protocol.js';

type Prompt = (review: Review, signal: AbortSignal) => Promise<ApprovalResolution>;

/**
 * Serializes reviews from several attached harness sessions onto one operator UI. At most `limit`
 * reviews may be active or waiting; more fail closed as `unavailable`. A waiter whose challenge is
 * cancelled or expires leaves at once, but the review behind it still waits for the active one.
 * `events` lets the host tell the operator when a review waits or is refused.
 */
export function queuedPrompt(prompt: Prompt, limit = 8, events: { queued?(waiting: number): void; refused?(): void } = {}): Prompt {
  let tail: Promise<void> = Promise.resolve(); let pending = 0;
  return async (review, signal) => {
    if (pending >= limit) { events.refused?.(); return 'unavailable'; }
    if (pending > 0) events.queued?.(pending);
    pending++;
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    let abandon!: () => void;
    const abandoned = new Promise<false>(resolve => { abandon = () => resolve(false); });
    signal.addEventListener('abort', abandon, { once: true });
    try {
      const ready = signal.aborted ? false : await Promise.race([previous.then(() => true as const), abandoned]);
      if (!ready || signal.aborted) return 'cancelled';
      return await prompt(review, signal);
    } catch { return 'unavailable'; }
    finally { signal.removeEventListener('abort', abandon); pending--; void previous.then(release); }
  };
}
