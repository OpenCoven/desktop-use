import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, rename, link, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
export type CleanupStage = "file-write-staging" | "observation-staging";
export type CleanupLimitation = { code: "TEMPORARY_CLEANUP_FAILED"; stages: CleanupStage[]; reason: string };
export function cleanupLimitation(stage: CleanupStage, previous?: CleanupLimitation): CleanupLimitation {
  return { code: "TEMPORARY_CLEANUP_FAILED", stages: [...new Set([...(previous?.stages ?? []), stage])],
    reason: "Temporary artifact cleanup failed; retained files may remain. Raw diagnostics withheld." };
}
// Preserve the operation failure independently of a later cleanup failure.
export class CleanupFailure extends Error {
  readonly #failure: unknown;
  get failure(): unknown { return this.#failure; }
  readonly cleanup: CleanupLimitation;
  readonly code: string;
  constructor(failure: unknown, stage: CleanupStage) {
    super("Temporary artifact cleanup failed; raw diagnostics withheld.");
    this.#failure = failure instanceof CleanupFailure ? failure.failure : failure;
    this.cleanup = cleanupLimitation(stage, failure instanceof CleanupFailure ? failure.cleanup : undefined);
    const code = (this.failure as { code?: unknown } | null)?.code;
    this.code = typeof code === "string" ? code : "ACTION_FAILED";
  }
}
export class FileActionError extends Error {
  constructor(readonly code: "CANCELLED" | "ETIMEDOUT" | "NOT_REGULAR_FILE" | "FILE_TOO_LARGE") {
    super(`File action failed (${code}).`); this.name = "FileActionError";
  }
}
function check(signal: AbortSignal | undefined, deadline: number) {
  if (signal?.aborted) throw new FileActionError("CANCELLED");
  if (Date.now() >= deadline) throw new FileActionError("ETIMEDOUT");
}

export async function readRegularFile(target: string, signal: AbortSignal | undefined, deadline: number): Promise<Buffer> {
  check(signal, deadline);
  // Nonblocking open prevents a FIFO from holding the worker before its type can be checked.
  const file = await open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat(); check(signal, deadline);
    if (!info.isFile()) throw new FileActionError("NOT_REGULAR_FILE");
    if (info.size > MAX_FILE_BYTES) throw new FileActionError("FILE_TOO_LARGE");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      check(signal, deadline);
      const { bytesRead } = await file.read(buffer, used, Math.min(64 * 1024, buffer.length - used), used);
      check(signal, deadline);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_FILE_BYTES) throw new FileActionError("FILE_TOO_LARGE");
    return buffer.subarray(0, used);
  } finally { await file.close(); }
}

export async function listDirectory(target: string, signal: AbortSignal | undefined, deadline: number) {
  check(signal, deadline);
  const directory = await opendir(target, { bufferSize: 32 });
  const entries: Array<{ name: string; kind: string }> = [];
  try {
    for (;;) {
      check(signal, deadline);
      const entry = await directory.read(); check(signal, deadline);
      if (!entry) return { entries, truncated: false };
      if (entries.length === 500) return { entries, truncated: true };
      entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
    }
  } finally { await directory.close(); }
}

export async function writeRegularFile(target: string, content: string | Buffer, overwrite: boolean, signal: AbortSignal | undefined, deadline: number): Promise<{ cleanup?: CleanupLimitation }> {
  check(signal, deadline);
  let mode = 0o600;
  try {
    const previous = await lstat(target); check(signal, deadline);
    if (!previous.isFile()) throw new FileActionError("NOT_REGULAR_FILE");
    mode = previous.mode & 0o777;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  check(signal, deadline);
  await mkdir(dirname(target), { recursive: true }); check(signal, deadline);
  const staging = await mkdtemp(join(dirname(target), ".desktopuse-write-"));
  const outcome: { cleanup?: CleanupLimitation } = {};
  let committed = false;
  let failure: unknown;
  try {
    check(signal, deadline);
    const source = join(staging, "content");
    const file = await open(source, "wx", 0o600);
    try {
      await file.writeFile(content, { encoding: "utf8" }); check(signal, deadline);
      await file.chmod(mode); check(signal, deadline);
    } finally { await file.close(); }
    // Commit only after the last cancellation/deadline check. Completed rename/link is not rolled back.
    check(signal, deadline);
    if (overwrite) await rename(source, target);
    else await link(source, target); // atomic no-overwrite, including a concurrent target creation
    committed = true;
  } catch (error) { failure = error; throw error; }
  finally {
    try { await rm(staging, { recursive: true, force: true }); }
    catch {
      if (!committed) throw new CleanupFailure(failure, "file-write-staging");
      outcome.cleanup = cleanupLimitation("file-write-staging");
    }
  }
  return outcome;
}
