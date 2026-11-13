import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { decodeAdapterAction, type ComputerUseParams, type ComputerUsePolicyContext } from "./computer-use-policy.js";
import { FileActionError, writeRegularFile } from "./file-actions.js";

export type ObservationImage = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };
const MAX_BYTES = 8 * 1024 * 1024;
const schema = JSON.parse(readFileSync(new URL("../contracts/v1/observation.schema.json", import.meta.url), "utf8"));

// Deliberately limited to the checked-in contract's JSON Schema vocabulary. No
// runtime SDK internals or image decoder dependencies are needed by this reader.
function matches(value: any, rule: any): boolean {
  if (rule.const !== undefined && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.oneOf && rule.oneOf.filter((r: any) => matches(value, r)).length !== 1) return false;
  if (rule.allOf && !rule.allOf.every((r: any) => matches(value, r))) return false;
  if (rule.not && matches(value, rule.not)) return false;
  if (rule.if && !matches(value, matches(value, rule.if) ? rule.then ?? {} : rule.else ?? {})) return false;
  const types = rule.type ? (Array.isArray(rule.type) ? rule.type : [rule.type]) : [];
  if (types.length && !types.some((t: string) => t === "null" ? value === null : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isSafeInteger(value) : typeof value === t)) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum) || (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum))) return false;
  if (typeof value === "string" && ((rule.minLength !== undefined && value.length < rule.minLength) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) return false;
  if (Array.isArray(value) && ((rule.minItems !== undefined && value.length < rule.minItems) || (rule.maxItems !== undefined && value.length > rule.maxItems) || (rule.items && !value.every(v => matches(v, rule.items))))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (rule.required?.some((k: string) => !Object.hasOwn(value, k))) return false;
    if (rule.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(rule.properties ?? {}, k))) return false;
    if (Object.entries(rule.properties ?? {}).some(([k, r]) => Object.hasOwn(value, k) && !matches(value[k], r))) return false;
  }
  return true;
}
function check(signal: AbortSignal | undefined, deadline: number) {
  if (signal?.aborted) throw new FileActionError("CANCELLED");
  if (Date.now() >= deadline) throw new FileActionError("ETIMEDOUT");
}
function invalid(): never { throw new Error("Invalid observation; diagnostics withheld."); }

function header(bytes: Buffer): { mimeType: string; width: number; height: number } {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) return { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      offset += length;
    }
  }
  return invalid();
}

async function exactFile(path: string, signal: AbortSignal | undefined, deadline: number): Promise<Buffer> {
  check(signal, deadline);
  const before = await lstat(path);
  if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES || before.nlink !== 1) invalid();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) invalid();
    const bytes = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < bytes.length) {
      check(signal, deadline);
      const { bytesRead } = await file.read(bytes, used, Math.min(65536, bytes.length - used), used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat(); const named = await lstat(path);
    check(signal, deadline);
    if (used !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) invalid();
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonical(dirname(path)), relative(dirname(path), path));
  }
}

// Receipts belong to the adapter envelope, outside Peekaboo's nested action.
function receiptFrom(value: unknown, depth = 0): unknown {
  if (depth > 8 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "observationV1")) return record.observationV1;
  return typeof record.adapter === "string" ? receiptFrom(record.result, depth + 1) : undefined;
}
function withoutReceipt(value: unknown, depth = 0): unknown {
  if (depth > 8 || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const { observationV1: _receipt, ...record } = value as Record<string, unknown>;
  if (Object.hasOwn(record, "result") && (typeof record.adapter === "string" || record.backend === "peekaboo")) record.result = withoutReceipt(record.result, depth + 1);
  return record;
}

/** Called only after validation and approval. Backend-returned paths are never authority. */
export async function withOwnedObservation(request: ComputerUseParams, _ctx: ComputerUsePolicyContext,
  runAdapter: (request: ComputerUseParams) => Promise<unknown>, signal?: AbortSignal) {
  const started = Date.now(); const deadline = started + (request.timeoutMs ?? 45000);
  check(signal, deadline);
  const directory = await mkdtemp(join(tmpdir(), "desktopuse-observation-"));
  const path = join(directory, "primary.image");
  try {
    const captured = await runAdapter({ ...request, path, timeoutMs: Math.max(1, deadline - Date.now()) });
    const decoded = decodeAdapterAction(captured);
    const raw = withoutReceipt(captured);
    if (decoded.ok !== true || decoded.supported === false || decoded.cancelled === true || decoded.timedOut === true || decoded.requiresConfirmation === true) return { raw };
    check(signal, deadline);
    let outputPublication: Record<string, unknown> | undefined;
    try {
      const receipt = receiptFrom(captured) as any;
      if (!matches(receipt, schema) || receipt.capturedAtMs < started || receipt.capturedAtMs > Date.now() || (request.mode && receipt.requestedScope.mode !== request.mode)) invalid();
      const bytes = await exactFile(path, signal, deadline);
      const dimensions = header(bytes); const primary = receipt.primaryImage;
      const source = primary.sourceDimensions; const delivered = primary.deliveredDimensions;
      if (primary.byteLength !== bytes.length || primary.sha256 !== createHash("sha256").update(bytes).digest("hex") || primary.mimeType !== dimensions.mimeType || source.width !== dimensions.width || source.height !== dimensions.height || delivered.width !== source.width || delivered.height !== source.height || source.width * source.height > 64000000 || source.width * source.height * 4 > 256 * 1024 * 1024 || receipt.coordinateReference.sourceExtent.width !== source.width || receipt.coordinateReference.sourceExtent.height !== source.height || primary.mimeType !== (request.action === "inspect" || request.action === "see" || request.format !== "jpg" ? "image/png" : "image/jpeg")) invalid();
      // Geometry is preserved only with the producer's evidence; never inferred from pixels.
      if (receipt.geometry.state === "available" && receipt.geometry.regions.some((r: any) => r.imageRect.x < 0 || r.imageRect.y < 0 || r.imageRect.x + r.imageRect.width > source.width || r.imageRect.y + r.imageRect.height > source.height)) invalid();
      if (request.path) {
        check(signal, deadline);
        if (await canonical(request.path) !== request.path) {
          outputPublication = { status: "needsApproval", success: false, code: "OUTPUT_TARGET_CHANGED" };
        } else {
          try {
            await writeRegularFile(request.path, bytes, true, signal, deadline);
            outputPublication = { status: "success", success: true, path: request.path, bytes: bytes.length };
          } catch (error) {
            if (error instanceof FileActionError && ["CANCELLED", "ETIMEDOUT"].includes(error.code)) throw error;
            outputPublication = { status: "error", success: false, code: "OUTPUT_PUBLICATION_FAILED" };
            throw error;
          }
        }
      }
      check(signal, deadline);
      const image: ObservationImage = { type: "image", mimeType: primary.mimeType, data: bytes.toString("base64") };
      check(signal, deadline);
      return { raw, image, observationV1: receipt, outputPublication,
        modelImageSupport: { state: "unknown", limitation: "An image block is supplied. The public tool context does not report selected-model image support; text-only models cannot inspect these pixels." } };
    } catch (error) {
      // A completed explicit write stays successful even if later delivery stops.
      if (!outputPublication && error instanceof FileActionError && ["CANCELLED", "ETIMEDOUT"].includes(error.code)) throw error;
      return { raw, outputPublication, observationUnavailable: { code: "OBSERVATION_VALIDATION_FAILED", reason: "Capture outcome is preserved; no validated image was delivered. Raw diagnostics withheld." } };
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
