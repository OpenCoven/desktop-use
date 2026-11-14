async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ACTIVE_CLEANUP_DEADLINE')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function cleanupMacActiveClient({ abort, pending, stopPending, close, closeLines,
  pendingTimeoutMs = 13_000, stopTimeoutMs = 1000, closeTimeoutMs = 2000 }) {
  let firstFailure, failed = false;
  const attempt = async operation => {
    try { await operation(); } catch (error) { if (!failed) firstFailure = error; failed = true; }
  };
  // Each phase is attempted independently. Failed pending-call cleanup cannot
  // prevent transport closure; retain the first failure across later cleanup.
  await attempt(() => abort());
  if (pending) await attempt(() => within(pending, pendingTimeoutMs));
  if (stopPending) await attempt(() => within(stopPending, stopTimeoutMs));
  await attempt(() => within(Promise.resolve().then(close), closeTimeoutMs));
  await attempt(() => closeLines());
  if (failed) throw firstFailure ?? new Error('ACTIVE_CLEANUP_FAILED');
}
