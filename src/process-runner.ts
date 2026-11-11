import { spawn } from "node:child_process";

export type ActionProgress = { completedSteps: number; totalSteps: number; failedStep?: number; partial: boolean };

function validatedProgress(output: Buffer): ActionProgress | undefined {
  try {
    const record = JSON.parse(output.toString("utf8"));
    if (!record || typeof record !== "object" || typeof record.ok !== "boolean") return undefined;
    const { completedSteps, totalSteps, failedStep } = record;
    if (!Number.isSafeInteger(completedSteps) || !Number.isSafeInteger(totalSteps) || totalSteps < 1 || completedSteps < 0 || completedSteps > totalSteps) return undefined;
    if (failedStep !== undefined && (!Number.isSafeInteger(failedStep) || failedStep < 0 || failedStep >= totalSteps || failedStep !== completedSteps)) return undefined;
    return { completedSteps, totalSteps, ...(failedStep !== undefined ? { failedStep } : {}), partial: completedSteps > 0 && completedSteps < totalSteps };
  } catch { return undefined; }
}

export class ProcessFailure extends Error {
  constructor(readonly code: string, readonly exitCode?: number | null, readonly progress?: ActionProgress) {
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
  if (options.signal?.aborted) return Promise.reject(new ProcessFailure("CANCELLED"));
  if (options.timeoutMs <= 0) return Promise.reject(new ProcessFailure("ETIMEDOUT"));
  return new Promise((resolve, reject) => {
    const unix = process.platform !== "win32";
    const child = spawn(file, args, {
      cwd: options.cwd,
      detached: unix,
      stdio: [options.input === undefined ? "ignore" : "pipe", options.capture === false ? "ignore" : "pipe", options.capture === false ? "ignore" : "pipe"],
    });
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
        reject(new ProcessFailure(error.code, error.exitCode, progress));
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
