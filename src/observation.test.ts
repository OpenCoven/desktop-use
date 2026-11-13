import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { readFile, writeFile, mkdtemp, rm, symlink, access, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createComputerUseTool, normalizeParams } from "./plugin-tool.js";

const fixture = async (kind = "png") => ({
  bytes: await readFile(new URL(`../contracts/v1/fixtures/images/valid.${kind}`, import.meta.url)),
  receipt: JSON.parse(await readFile(new URL(`../contracts/v1/fixtures/observations/valid-${kind}.json`, import.meta.url), "utf8")),
});
async function capture(kind = "png", mutate?: (path: string, receipt: any, bytes: Buffer) => Promise<unknown>) {
  const { bytes, receipt } = await fixture(kind);
  let owned = "";
  let approval = false;
  const audits: unknown[] = [];
  const tool = createComputerUseTool({ approvalProvider: async () => approval ? "allowed" : "unavailable", appendAuditEvent: async event => { audits.push(event); }, runAdapter: async (_args, params) => {
    owned = params.path!;
    assert.ok(owned, "caller supplies a private destination");
    assert.equal((await stat(dirname(owned))).mode & 0o777, 0o700);
    await writeFile(owned, bytes);
    receipt.capturedAtMs = Date.now();
    const override = await mutate?.(owned, receipt, bytes);
    return override ?? { ok: true, supported: true, platform: "linux", backend: "scrot", exitCode: 0, stdoutRedacted: true, purpose: params.action, path: owned, observationV1: receipt };
  } });
  return { tool, bytes, audits, approve: () => { approval = true; }, owned: () => owned };
}
for (const kind of ["png", "jpg"]) test(`delivers exact validated ${kind} bytes without default-path approval and cleans private staging`, async () => {
  const c = await capture(kind);
  const result = await c.tool.execute("image", { action: "screenshot", mode: "screen", format: kind });
  assert.equal(result.details.status, "success");
  const image = result.content.find(block => block.type === "image");
  assert.ok(image, "image is explicit typed content");
  assert.equal(image.mimeType, kind === "png" ? "image/png" : "image/jpeg");
  assert.deepEqual(Buffer.from(image.data, "base64"), c.bytes);
  assert.equal((result.details.observationV1 as any).geometry.state, "unavailable");
  assert.equal((result.details.result as any).path, c.owned(), "default path describes temporary capture provenance only");
  assert.equal(result.details.outputPublication, undefined);
  assert.equal(JSON.stringify(result.details).includes(image.data), false);
  assert.equal(JSON.stringify(c.audits).includes(image.data), false);
  assert.equal(JSON.stringify(c.audits).includes(c.owned()), false);
  await assert.rejects(access(dirname(c.owned())), { code: "ENOENT" });
});

test("explicit destinations require approval and publish the approved bytes atomically", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-destination-")));
  try {
    const c = await capture(); const path = join(root, "output.jpg");
    const blocked = await c.tool.execute("unapproved", { action: "screenshot", mode: "screen", path });
    assert.equal(blocked.details.status, "needsApproval"); assert.equal(c.owned(), "");
    await writeFile(path, "old");
    c.approve(); const result = await c.tool.execute("approved", { action: "screenshot", mode: "screen", path, confirm: true });
    assert.equal(result.details.status, "success"); assert.notEqual(c.owned(), path);
    assert.deepEqual(await readFile(path), c.bytes);
    assert.equal((result.details.outputPublication as any).status, "success");
    assert.equal((result.details.result as any).path, path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const variant of ["hash", "dimensions", "version", "stale", "type", "size", "extent", "scope", "symlink", "missing"]) test(`withholds ${variant} artifact and keeps successful capture outcome truthful`, async () => {
  const c = await capture("png", async (path, receipt) => {
    if (variant === "hash") receipt.primaryImage.sha256 = "0".repeat(64);
    if (variant === "dimensions") receipt.primaryImage.sourceDimensions.width++;
    if (variant === "version") receipt.schemaVersion = 2;
    if (variant === "stale") receipt.capturedAtMs = 0;
    if (variant === "type") receipt.primaryImage.mimeType = "image/jpeg";
    if (variant === "size") await writeFile(path, Buffer.alloc(8388609));
    if (variant === "extent") receipt.coordinateReference.sourceExtent.width++;
    if (variant === "scope") receipt.requestedScope.mode = "window";
    if (variant === "symlink") { await rm(path); await symlink(new URL("../contracts/v1/fixtures/images/valid.png", import.meta.url), path); }
    if (variant === "missing") await rm(path);
  });
  const result = await c.tool.execute("invalid", { action: "screenshot", mode: "screen" });
  assert.equal(result.details.status, "success");
  assert.equal(result.content.some(block => block.type === "image"), false);
  assert.equal((result.details.observationUnavailable as any).code, "OBSERVATION_VALIDATION_FAILED");
  assert.equal(result.details.observationV1, undefined);
  await assert.rejects(access(dirname(c.owned())), { code: "ENOENT" });
});

for (const outcome of ["failed", "cancelled"]) test(`${outcome} capture never delivers or publishes a stale artifact`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-cancel-")));
  try {
    const abort = new AbortController();
    const c = await capture("png", async () => { if (outcome === "cancelled") abort.abort(); return { ok: outcome === "cancelled", code: outcome === "failed" ? "BACKEND_ERROR" : undefined }; });
    const path = join(root, "output.png");
    c.approve(); const result = await c.tool.execute("cancel", { action: "screenshot", mode: "screen", path, confirm: true }, abort.signal);
    assert.equal(result.content.some(block => block.type === "image"), false);
    assert.equal(result.details.status, outcome === "cancelled" ? "cancelled" : "error");
    await assert.rejects(access(path), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepts bounded signed i32 coordinates and passes a literal option value", async () => {
  for (const coords of ["-1920,-80", "-2147483648,2147483647", " 120,240 "]) {
    let argv: string[] = [];
    const tool = createComputerUseTool({ approvalProvider: async () => "allowed" as const, appendAuditEvent: async () => {}, runAdapter: async args => { argv = args; return { ok: true }; } });
    await tool.execute("negative", { action: "click", coords, confirm: true });
    assert.deepEqual(argv, ["click", "--confirm", "--coords", coords]);
  }
  for (const coords of ["-2147483649,0", "2147483648,0", "--help,0"]) assert.throws(() => normalizeParams({ action: "click", coords }));
});

test("uses the adapter's outer macOS receipt while preserving nested backend outcome", async () => {
  const c = await capture("png", async (_path, receipt) => ({ ok: true, backend: "peekaboo", result: { success: true }, observationV1: receipt }));
  const result = await c.tool.execute("mac-envelope", { action: "screenshot", mode: "screen" });
  assert.ok(result.content.some(block => block.type === "image"));
});

test("does not expose an unvalidated receipt in legacy result metadata", async () => {
  const c = await capture("png", async (_path, receipt) => { receipt.schemaVersion = 99; });
  const result = await c.tool.execute("invalid-version", { action: "screenshot", mode: "screen" });
  assert.equal(JSON.stringify(result.details).includes('"schemaVersion":99'), false);
});

test("rechecks approved destination binding after capture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-rebind-")));
  try {
    const parent = join(root, "approved"), other = join(root, "other");
    const { mkdir, rename } = await import("node:fs/promises"); await mkdir(parent); await mkdir(other);
    const c = await capture("png", async () => { await rename(parent, join(root, "old")); await symlink(other, parent); });
    c.approve(); const result = await c.tool.execute("rebound", { action: "screenshot", mode: "screen", path: join(parent, "out.png"), confirm: true });
    assert.equal((result.details.outputPublication as any).status, "needsApproval");
    assert.equal((result.details.result as any).path, c.owned());
    assert.notEqual((result.details.result as any).path, join(parent, "out.png"));
    await assert.rejects(access(join(other, "out.png")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports an explicit publication failure separately from successful capture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-write-fail-")));
  try {
    const path = join(root, "destination");
    const { mkdir } = await import("node:fs/promises"); await mkdir(path);
    const c = await capture();
    c.approve(); const result = await c.tool.execute("publish-fail", { action: "screenshot", mode: "screen", path, confirm: true });
    assert.equal(result.details.status, "success");
    assert.equal((result.details.outputPublication as any)?.status, "error");
    assert.equal((result.details.outputPublication as any)?.code, "OUTPUT_PUBLICATION_FAILED");
    assert.equal((result.details.result as any).path, c.owned());
    assert.equal(result.content.some(block => block.type === "image"), false);
    assert.equal((await stat(path)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preserves completed explicit output if the shared deadline expires before delivery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-late-timeout-")));
  const path = join(root, "output.png");
  const originalNow = Date.now;
  const { existsSync } = await import("node:fs");
  try {
    const c = await capture();
    Date.now = () => originalNow() + (existsSync(path) ? 2000 : 0);
    c.approve(); const result = await c.tool.execute("late-timeout", { action: "screenshot", mode: "screen", path, confirm: true, timeoutMs: 1000 });
    assert.equal(result.details.status, "success");
    assert.equal((result.details.outputPublication as any).status, "success");
    assert.equal((result.details.result as any).path, path);
    assert.ok(result.details.observationUnavailable);
    assert.equal(result.content.some(block => block.type === "image"), false);
    assert.deepEqual(await readFile(path), c.bytes);
  } finally { Date.now = originalNow; await rm(root, { recursive: true, force: true }); }
});

test("inspect delivers the owned primary with truthful unknown annotation, ignoring extra backend artifacts", async () => {
  const c = await capture("png", async (_path, receipt) => {
    receipt.requestedScope.annotationRequested = true;
    receipt.primaryImage.annotationKind = "unverified";
    receipt.primaryImage.annotationReasonCode = "PROVIDER_ANNOTATION_UNVERIFIED";
    return { ok: true, path: "/untrusted/raw.png", annotationPath: "/untrusted/annotated.png", observationV1: receipt };
  });
  const result = await c.tool.execute("inspect", { action: "inspect", mode: "screen" });
  assert.equal(result.content.filter(block => block.type === "image").length, 1);
  assert.equal((result.details.observationV1 as any).primaryImage.annotationKind, "unverified");
  const image = result.content.find(block => block.type === "image")!;
  assert.deepEqual(Buffer.from(image.data, "base64"), c.bytes);
});

for (const [code, status] of [["CANCELLED", "cancelled"], ["ETIMEDOUT", "timeout"]] as const) {
  for (const nested of [false, true]) test(`${code} precedence suppresses a valid ${nested ? "nested" : "flat"} capture and explicit publication`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "observation-code-outcome-")));
    try {
      const path = join(root, "output.png"); await writeFile(path, "previous destination");
      const c = await capture("png", async (_path, receipt) => nested
        ? { ok: true, backend: "peekaboo", result: { success: true, code }, observationV1: receipt }
        : { ok: true, code, observationV1: receipt });
      c.approve(); const result = await c.tool.execute("code-outcome", { action: "screenshot", mode: "screen", path, confirm: true });
      assert.equal(result.details.status, status);
      assert.equal(result.content.some(block => block.type === "image"), false);
      assert.equal(result.details.outputPublication, undefined);
      assert.equal(result.details.observationV1, undefined);
      assert.equal(await readFile(path, "utf8"), "previous destination");
      await assert.rejects(access(dirname(c.owned())), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const failedStages of [["file-write-staging"], ["observation-staging"], ["file-write-staging", "observation-staging"]]) test(`preserves published pixels and image after ${failedStages.join(" and ")} cleanup failure`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-cleanup-fault-")));
  const originalRm = fs.rm;
  const c = await capture(); const path = join(root, "output.png");
  let failures = 0;
  const fault = mock.method(fs, "rm", async (target: any, options: any) => {
    const stage = String(target).includes(".desktopuse-write-") ? "file-write-staging"
      : String(target) === dirname(c.owned()) ? "observation-staging" : undefined;
    if (stage && failedStages.includes(stage)) {
      assert.deepEqual(await readFile(path), c.bytes, "fault occurs after destination commit");
      failures++;
      throw Object.assign(new Error(`private cleanup diagnostics ${target} ${c.bytes.toString("base64")}`), { code: "EACCES" });
    }
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    c.approve(); const result = await c.tool.execute("cleanup-fault", { action: "screenshot", mode: "screen", path, confirm: true });
    assert.equal(failures, failedStages.length);
    assert.equal(result.details.status, "success");
    assert.equal((result.details.outputPublication as any).status, "success");
    assert.equal((result.details.result as any).path, path);
    assert.deepEqual(await readFile(path), c.bytes);
    assert.equal((result.details.cleanup as any).code, "TEMPORARY_CLEANUP_FAILED");
    assert.deepEqual((result.details.cleanup as any).stages, failedStages);
    assert.ok(result.content.some(block => block.type === "image"));
    const metadata = JSON.stringify({ details: result.details, audits: c.audits });
    assert.equal(metadata.includes("private cleanup diagnostics"), false);
    assert.equal(metadata.includes(c.bytes.toString("base64")), false);
    assert.equal(JSON.stringify(c.audits).includes(c.owned()), false);
  } finally {
    fault.mock.restore(); syncBuiltinESMExports();
    await originalRm(root, { recursive: true, force: true });
    if (c.owned()) await originalRm(dirname(c.owned()), { recursive: true, force: true });
  }
});

test("canonical target I/O failure reports a separate failed publication", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-canonical-fault-")));
  try {
    const parent = join(root, "parent"); await fs.mkdir(parent);
    const c = await capture("png", async () => { await fs.rename(parent, join(root, "previous")); await writeFile(parent, "not a directory"); });
    c.approve(); const result = await c.tool.execute("canonical-io", { action: "screenshot", mode: "screen", path: join(parent, "output.png"), confirm: true });
    assert.equal(result.details.status, "success");
    assert.equal((result.details.outputPublication as any)?.code, "OUTPUT_PUBLICATION_FAILED");
    assert.equal(result.content.some(block => block.type === "image"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup failure preserves code-based cancellation with no private diagnostics", async () => {
  const originalRm = fs.rm;
  const c = await capture("png", async (_path, receipt) => ({ ok: true, code: "CANCELLED", observationV1: receipt }));
  const fault = mock.method(fs, "rm", async (target: any, options: any) => {
    if (String(target) === dirname(c.owned())) throw new Error("private cleanup diagnostics");
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    const result = await c.tool.execute("cancel-cleanup", { action: "screenshot", mode: "screen" });
    assert.equal(result.details.status, "cancelled");
    assert.equal((result.details.cleanup as any).code, "TEMPORARY_CLEANUP_FAILED");
    assert.equal(result.content.some(block => block.type === "image"), false);
    assert.equal(JSON.stringify(result.details).includes("private cleanup diagnostics"), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); if (c.owned()) await originalRm(dirname(c.owned()), { recursive: true, force: true }); }
});

test("runner cancellation remains cancelled when final observation cleanup also fails", async () => {
  const originalRm = fs.rm;
  const { FileActionError } = await import("./file-actions.js");
  const c = await capture("png", async () => { throw new FileActionError("CANCELLED"); });
  const fault = mock.method(fs, "rm", async (target: any, options: any) => {
    if (String(target) === dirname(c.owned())) throw new Error("private cleanup diagnostics");
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    const result = await c.tool.execute("runner-cancel-cleanup", { action: "screenshot", mode: "screen" });
    assert.equal(result.details.status, "cancelled");
    assert.equal(result.details.code, "CANCELLED");
    assert.equal((result.details.cleanup as any).code, "TEMPORARY_CLEANUP_FAILED");
    assert.equal(result.content.some(block => block.type === "image"), false);
    assert.equal(JSON.stringify(result).includes("private cleanup diagnostics"), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); if (c.owned()) await originalRm(dirname(c.owned()), { recursive: true, force: true }); }
});

test("precommit cancellation and both cleanup failures preserve cancellation without replacing the destination", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-combined-cancel-")));
  const path = join(root, "output.png"); await writeFile(path, "previous destination");
  const controller = new AbortController(); const c = await capture();
  const originalRm = fs.rm, originalOpen = fs.open;
  const openFault = mock.method(fs, "open", async (target: any, flags: any, mode: any) => {
    const file = await originalOpen(target, flags, mode);
    if (String(target).includes(".desktopuse-write-")) controller.abort();
    return file;
  });
  const cleanupFault = mock.method(fs, "rm", async (target: any, options: any) => {
    if (String(target).includes(".desktopuse-write-") || String(target) === dirname(c.owned())) throw new Error("private cleanup diagnostics");
    return originalRm(target, options);
  });
  syncBuiltinESMExports();
  try {
    c.approve(); const result = await c.tool.execute("precommit-cancel-cleanup", { action: "screenshot", mode: "screen", path, confirm: true }, controller.signal);
    assert.equal(result.details.status, "cancelled");
    assert.equal(result.details.code, "CANCELLED");
    assert.deepEqual((result.details.cleanup as any).stages, ["file-write-staging", "observation-staging"]);
    assert.equal(result.content.some(block => block.type === "image"), false);
    assert.equal(await readFile(path, "utf8"), "previous destination");
    assert.equal(JSON.stringify(result.details).includes(path), false, "cancelled publication must not advertise the requested destination");
    assert.equal(JSON.stringify(result).includes("private cleanup diagnostics"), false);
  } finally {
    openFault.mock.restore(); cleanupFault.mock.restore(); syncBuiltinESMExports();
    await originalRm(root, { recursive: true, force: true });
    if (c.owned()) await originalRm(dirname(c.owned()), { recursive: true, force: true });
  }
});

for (const variant of ["overlap", "unknown-evidence-version", "stale-evidence", "overflow"]) test(`rejects ambiguous or unbound geometry: ${variant}`, async () => {
  const c = await capture("png", async (_path, receipt) => {
    const region = { imageRect: { x: 0, y: 0, width: 32, height: 24 }, desktopRect: { x: -800, y: 0, width: 16, height: 12 } };
    receipt.geometry = { state: "available", coordinateUnits: "desktop-logical-pixels", regions: [region], evidence: { kind: "platform-probe", provider: { name: "sway", version: "1.7" }, capturedAtMs: receipt.capturedAtMs } };
    if (variant === "overlap") receipt.geometry.regions.push(structuredClone(region));
    if (variant === "unknown-evidence-version") receipt.geometry.evidence.provider.version = null;
    if (variant === "stale-evidence") receipt.geometry.evidence.capturedAtMs = 0;
    if (variant === "overflow") region.desktopRect.x = 2147483647;
  });
  const result = await c.tool.execute("geometry", { action: "screenshot", mode: "screen" });
  assert.equal(result.content.some(c => c.type === "image"), false);
  assert.equal((result.details.observationUnavailable as any).code, "OBSERVATION_VALIDATION_FAILED");
});

test("shared producer contracts retain large original extents and negative piecewise geometry", async () => {
  const cases = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/geometry/producers.json", import.meta.url), "utf8"));
  for (const f of cases) {
    const c = await capture("png", async (path, receipt) => {
      const [width, height] = f.raster;
      const bytes = await readFile(new URL(`../contracts/v1/fixtures/images/geometry-${width}x${height}.png`, import.meta.url));
      await writeFile(path, bytes);
      receipt.primaryImage = { ...receipt.primaryImage, byteLength: bytes.length, sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"), sourceDimensions: { width, height }, deliveredDimensions: { width, height } };
      receipt.coordinateReference.sourceExtent = { x: 0, y: 0, width, height };
      receipt.geometry = { state: "available", coordinateUnits: f.units, regions: f.regions, evidence: { kind: f.producer === "peekaboo-coordinate-context" ? "provider-receipt" : "platform-probe", provider: { name: f.producer, version: f.version }, capturedAtMs: receipt.capturedAtMs } };
    });
    const result = await c.tool.execute("large-geometry", { action: "screenshot", mode: "screen" });
    assert.ok(result.content.some(c => c.type === "image"));
    assert.deepEqual((result.details.observationV1 as any).geometry.regions, f.regions);
    assert.deepEqual((result.details.observationV1 as any).coordinateReference.sourceExtent, { x: 0, y: 0, width: f.raster[0], height: f.raster[1] });
  }
});

// A missing post-publication rebind must fail these consumer-visible path checks.
for (const shape of ["screenshot_raw", "files"] as const) test(`published Peekaboo ${shape} primary follows the approved path without rewriting other artifacts`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-mac-primary-")));
  try {
    const path = join(root, "published.png");
    const c = await capture("png", async (owned, receipt) => ({
      ok: true, adapter: "coven-desktop-use", result: {
        ok: true, backend: "peekaboo", path: owned, observationV1: receipt,
        result: { success: true, data: {
          ...(shape === "screenshot_raw" ? { screenshot_raw: owned, screenshot_annotated: owned, ui_map: owned }
            : { files: [{ path: owned, item_label: "Display 1 (Index 0)", mime_type: "image/png" }], observations: [], snapshot_id: "fixture" }),
          path: owned, analysis: { text: owned },
        } },
      },
    }));
    c.approve(); const result = await c.tool.execute("mac-published", { action: "inspect", mode: "screen", path, confirm: true });
    assert.equal(result.details.status, "success");
    const adapter = (result.details.result as any).result;
    assert.equal(adapter.path, path);
    const data = adapter.result.data;
    assert.equal(shape === "screenshot_raw" ? data.screenshot_raw : data.files[0].path, path);
    assert.equal(data.path, c.owned());
    assert.equal(data.analysis.text, c.owned());
    if (shape === "screenshot_raw") {
      assert.equal(data.screenshot_annotated, c.owned());
      assert.equal(data.ui_map, c.owned());
    } else assert.equal(data.files[0].item_label, "Display 1 (Index 0)");
    assert.deepEqual(await readFile(path), c.bytes);
    await assert.rejects(access(c.owned()), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("published image does not relabel unrelated or ambiguous Peekaboo artifact paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observation-mac-other-")));
  try {
    const path = join(root, "published.png");
    const c = await capture("png", async (owned, receipt) => ({ ok: true, backend: "peekaboo", path: owned, observationV1: receipt,
      result: { success: true, data: { screenshot_raw: "/untrusted/raw.png", files: [{ path: owned }, { path: "/untrusted/second.png" }] } },
    }));
    c.approve(); const result = await c.tool.execute("mac-other", { action: "screenshot", mode: "screen", path, confirm: true });
    const data = (result.details.result as any).result.data;
    assert.equal((result.details.result as any).path, path);
    assert.equal(data.screenshot_raw, "/untrusted/raw.png");
    assert.deepEqual(data.files, [{ path: c.owned() }, { path: "/untrusted/second.png" }]);
    assert.deepEqual(await readFile(path), c.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
