import { spawn } from "node:child_process";

export type ActionProgress = { completedSteps: number; totalSteps: number; failedStep?: number; completedInputCharacters?: number; inputMayHaveStarted?: boolean; partial: boolean };

export type InputCleanup = { schemaVersion: 1; state: "verified" | "unverified" | "not-needed"; reasonCode?: string; releasedKeys?: number; restoredKeys?: number; restoredButtons?: number; restoredMappings?: number; restoredLock?: boolean; restoredGroup?: boolean };

export function validatedInputCleanup(value: unknown): InputCleanup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.state !== "string" || !["verified", "unverified", "not-needed"].includes(record.state)) return undefined;
  const reasons = ["X11_GUARD_UNAVAILABLE", "X11_GUARD_TIMEOUT", "X11_PLAN_UNVERIFIED", "X11_STATE_CHANGED", "X11_CLEANUP_FAILED", "ADAPTER_RESULT_UNAVAILABLE"];
  if (record.state === "unverified" ? typeof record.reasonCode !== "string" || !reasons.includes(record.reasonCode) : record.reasonCode !== undefined) return undefined;
  const result: InputCleanup = { schemaVersion: 1, state: record.state as InputCleanup["state"], ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode as string }) };
  for (const [key, limit] of [["releasedKeys", 256], ["restoredKeys", 256], ["restoredButtons", 5], ["restoredMappings", 1]] as const) {
    if (record[key] === undefined) continue;
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0 || (record[key] as number) > limit) return undefined;
    result[key] = record[key] as number;
  }
  for (const key of ["restoredLock", "restoredGroup"] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "boolean") return undefined;
    result[key] = record[key];
  }
  return result;
}

function validatedProgress(output: Buffer): ActionProgress | undefined {
  try {
    const record = JSON.parse(output.toString("utf8"));
    if (!record || typeof record !== "object" || typeof record.ok !== "boolean") return undefined;
    const { completedSteps, totalSteps, failedStep } = record;
    if (!Number.isSafeInteger(completedSteps) || !Number.isSafeInteger(totalSteps) || totalSteps < 1 || completedSteps < 0 || completedSteps > totalSteps) return undefined;
    if (failedStep !== undefined && (!Number.isSafeInteger(failedStep) || failedStep < 0 || failedStep >= totalSteps || failedStep !== completedSteps)) return undefined;
    const characters = record.completedInputCharacters;
    if (characters !== undefined && (!Number.isSafeInteger(characters) || characters < 0 || characters > 1_000_000)) return undefined;
    if (record.inputMayHaveStarted !== undefined && typeof record.inputMayHaveStarted !== "boolean") return undefined;
    return { completedSteps, totalSteps, ...(failedStep !== undefined ? { failedStep } : {}), ...(characters === undefined ? {} : { completedInputCharacters: characters }), ...(record.inputMayHaveStarted === undefined ? {} : { inputMayHaveStarted: record.inputMayHaveStarted }), partial: completedSteps > 0 && completedSteps < totalSteps || failedStep !== undefined && (characters > 0 || record.inputMayHaveStarted === true) };
  } catch { return undefined; }
}

export type ProcessLifecycle = "not-started" | "spawn-failed" | "started" | "unknown";

export class ProcessFailure extends Error {
  constructor(readonly code: string, readonly exitCode?: number | null, readonly progress?: ActionProgress, readonly lifecycle: ProcessLifecycle = "unknown", readonly inputCleanup?: InputCleanup) {
    super(`Helper execution failed (${code}); raw arguments and diagnostics withheld.`);
    this.name = "ProcessFailure";
  }
}

export type ProcessOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
  input?: string;
  maxBuffer?: number;
  capture?: boolean;
  reportProgress?: boolean;
  // Clipboard tools deliberately transfer ownership to their own background selection server.
  retainGroupOnSuccess?: boolean;
};

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) return Promise.reject(new ProcessFailure("CANCELLED", undefined, undefined, "not-started"));
  if (options.timeoutMs <= 0) return Promise.reject(new ProcessFailure("ETIMEDOUT", undefined, undefined, "not-started"));
  return new Promise((resolve, reject) => {
    const unix = process.platform !== "win32";
    const child = spawn(file, args, {
      cwd: options.cwd,
      detached: unix,
      stdio: [options.input === undefined ? "ignore" : "pipe", options.capture === false ? "ignore" : "pipe", options.capture === false ? "ignore" : "pipe"],
    });
    let started = false;
    child.once("spawn", () => { started = true; });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let failure: ProcessFailure | undefined;
    let done = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (unix) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    const finish = (error?: ProcessFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      if (error || !options.retainGroupOnSuccess) kill("SIGKILL");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) {
        const progress = options.reportProgress && ["ETIMEDOUT", "CANCELLED"].includes(error.code) ? validatedProgress(out) : undefined;
        let inputCleanup: InputCleanup | undefined;
        if (options.reportProgress && ["ETIMEDOUT", "CANCELLED"].includes(error.code)) {
          try { inputCleanup = validatedInputCleanup(JSON.parse(out.toString("utf8"))?.inputCleanup); } catch { /* incomplete native output carries no cleanup proof */ }
        }
        reject(new ProcessFailure(error.code, error.exitCode, progress, started ? "started" : "spawn-failed", inputCleanup));
      }
      else resolve({ stdout: out.toString("utf8"), stderr: err.toString("utf8") });
    };
    const stop = (error: ProcessFailure) => {
      if (failure || done) return;
      failure = error;
      kill("SIGTERM");
      escalation = setTimeout(() => { kill("SIGKILL"); finish(error); }, 250);
    };
    const abort = () => stop(new ProcessFailure("CANCELLED"));
    const timer = setTimeout(() => stop(new ProcessFailure("ETIMEDOUT")), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (kind: "out" | "err", chunk: Buffer) => {
      if (done) return;
      if (out.length + err.length + chunk.length > (options.maxBuffer ?? 64_000)) {
        if (!failure) stop(new ProcessFailure("OUTPUT_LIMIT"));
      } else if (kind === "out") out = Buffer.concat([out, chunk]);
      else err = Buffer.concat([err, chunk]);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("err", chunk));
    child.on("error", (error: NodeJS.ErrnoException) => finish(new ProcessFailure(error.code === "ENOENT" ? "ENOENT" : error.code === "EACCES" ? "EACCES" : "PROCESS_ERROR")));
    child.on("close", (code, signal) => finish(failure ?? (code === 0 && !signal ? undefined : new ProcessFailure("PROCESS_EXIT", code))));
    child.stdin?.on("error", () => stop(new ProcessFailure("STDIN_ERROR")));
    child.stdin?.end(options.input);
  });
}
