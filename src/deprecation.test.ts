import assert from "node:assert/strict";
import test from "node:test";
import { createComputerUseTool, createDesktopUseTool, normalizeParams, prepareComputerUseRequest } from "./plugin-tool.js";
import type { ComputerUseAuditEvent } from "./computer-use-audit.js";
import type { ComputerUseParams } from "./computer-use-policy.js";
import { planHostAction } from "./host-actions.js";

const aliases = [
  { legacy: "permissions", canonical: "doctor", extra: {}, argv: ["doctor"] },
  { legacy: "see", canonical: "inspect", extra: {}, argv: ["inspect"] },
  { legacy: "capture", canonical: "screenshot", extra: {}, argv: ["screenshot"] },
  { legacy: "type", canonical: "type-text", extra: { text: "hello", confirm: true }, argv: ["type-text", "--confirm", "--text", "hello"] },
  { legacy: "press", canonical: "keypress", extra: { keys: ["tab"], confirm: true }, argv: ["keypress", "--confirm", "--keys", "tab"] },
] as const;

function harness(legacyTool = false, response: unknown = { ok: true }) {
  const calls: string[][] = [];
  const audits: ComputerUseAuditEvent[] = [];
  const tool = (legacyTool ? createDesktopUseTool : createComputerUseTool)({
    runAdapter: async args => { calls.push(args); return response; },
    appendAuditEvent: async event => { audits.push(event); },
  });
  return { tool, calls, audits };
}

function notice(result: Awaited<ReturnType<ReturnType<typeof createComputerUseTool>["execute"]>>) {
  assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.details)));
  assert.equal(typeof result.details.deprecation, "string");
  return result.details.deprecation as string;
}

for (const { legacy, canonical, extra, argv } of aliases) {
  test(`${legacy} still executes ${canonical} and returns a deprecation notice`, async () => {
    const { tool, calls, audits } = harness();
    const result = await tool.execute("legacy", { action: legacy, ...extra });
    assert.deepEqual(calls, [argv]);
    assert.equal(result.details.status, "success");
    assert.equal(result.details.success, true);
    assert.equal(result.details.action, canonical);
    assert.match(notice(result), new RegExp(`${legacy}.*${canonical}`));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, canonical);
    assert.deepEqual(audits[0].result, { status: "success", success: true });
  });
}

test("desktop_use still executes and names computer_use as its replacement", async () => {
  const { tool, calls, audits } = harness(true);
  const result = await tool.execute("legacy-tool", { action: "doctor" });
  assert.deepEqual(calls, [["doctor"]]);
  assert.equal(result.details.status, "success");
  assert.match(notice(result), /desktop_use.*computer_use/);
  assert.equal(audits.length, 1);
});

test("canonical actions and type-text text input return no notice", async () => {
  for (const { canonical, extra } of aliases) {
    const { tool } = harness();
    const result = await tool.execute("canonical", { action: canonical, ...extra });
    assert.equal(result.details.status, "success");
    assert.equal(Object.hasOwn(result.details, "deprecation"), false);
    assert.equal(Object.hasOwn(JSON.parse(result.content[0].text), "deprecation"), false);
  }
  const { tool } = harness();
  const result = await tool.execute("canonical-clipboard", { action: "clipboard-write", clipboardText: "hello" });
  assert.equal(result.details.status, "needsApproval");
  assert.equal(Object.hasOwn(result.details, "deprecation"), false);
});

test("clipboard-write text remains accepted with a notice and the same approval and host input", async () => {
  const { tool, calls, audits } = harness();
  const result = await tool.execute("legacy-clipboard", { action: "clipboard-write", text: "hello" });
  assert.equal(result.details.status, "needsApproval");
  assert.equal(result.details.requiresApproval, true);
  assert.deepEqual(calls, []);
  assert.match(notice(result), /text.*clipboardText/);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].result, { status: "needsApproval", success: false });
  const legacy = normalizeParams({ action: "clipboard-write", text: "hello", confirm: true });
  const canonical = normalizeParams({ action: "clipboard-write", clipboardText: "hello", confirm: true });
  assert.equal((await prepareComputerUseRequest(legacy)).decision.status, "allow");
  assert.deepEqual(planHostAction("linux", { WAYLAND_DISPLAY: "wayland-0" }, () => "/fixture/wl-copy", legacy),
    planHostAction("linux", { WAYLAND_DISPLAY: "wayland-0" }, () => "/fixture/wl-copy", canonical));
  assert.equal(planHostAction("linux", { WAYLAND_DISPLAY: "wayland-0" }, () => "/fixture/wl-copy", legacy).input, "hello");
});

test("clipboardText keeps precedence when deprecated text is also supplied", async () => {
  const { tool } = harness();
  const params = { action: "clipboard-write", text: "old", clipboardText: "new" } as const;
  const result = await tool.execute("both-fields", params);
  assert.match(notice(result), /text.*clipboardText/);
  assert.equal(planHostAction("linux", { WAYLAND_DISPLAY: "wayland-0" }, () => "/fixture/wl-copy", params).input, "new");
});

test("simultaneous legacy tool and action or clipboard names retain every notice", async () => {
  const { tool } = harness(true);
  const action = await tool.execute("combined-action", { action: "permissions" });
  assert.match(notice(action), /desktop_use.*computer_use/);
  assert.match(notice(action), /permissions.*doctor/);
  const clipboard = await tool.execute("combined-field", { action: "clipboard-write", text: "hello" });
  assert.match(notice(clipboard), /desktop_use.*computer_use/);
  assert.match(notice(clipboard), /text.*clipboardText/);
});

test("legacy names preserve approval decisions and redacted audit results", async () => {
  for (const legacyTool of [false, true]) {
    for (const { legacy, canonical, extra } of aliases) {
      const old = harness(legacyTool);
      const current = harness();
      const oldResult = await old.tool.execute("same-call", { action: legacy, ...extra, confirm: false });
      const currentResult = await current.tool.execute("same-call", { action: canonical, ...extra, confirm: false });
      const { deprecation, ...oldDetails } = oldResult.details;
      assert.match(notice(oldResult), new RegExp(`${legacy}.*${canonical}`));
      // Approval responses keep their original request action; policy and audit normalize it.
      const oldParams = oldDetails.params as ComputerUseParams | undefined;
      if (oldParams) oldDetails.params = { ...oldParams, action: canonical };
      const prompt = oldDetails.approvalPrompt as { description: string; exactInput: string } | undefined;
      if (prompt) {
        assert.ok(prompt.exactInput.includes(`"action":"${legacy}"`));
        oldDetails.approvalPrompt = {
          ...prompt,
          description: prompt.description.replace(`"action":"${legacy}"`, `"action":"${canonical}"`),
          exactInput: prompt.exactInput.replace(`"action":"${legacy}"`, `"action":"${canonical}"`),
        };
      }
      assert.deepEqual(oldDetails, currentResult.details);
      assert.deepEqual(old.calls, current.calls);
      const { timestamp: oldTime, ...oldAudit } = old.audits[0];
      const { timestamp: currentTime, ...currentAudit } = current.audits[0];
      assert.deepEqual(oldAudit, currentAudit);
    }
  }
});

for (const response of [{ ok: false, error: "backend failed" }, { ok: false, supported: false }, { ok: false, requiresConfirmation: true }]) {
  test(`deprecation preserves backend outcome ${JSON.stringify(response)}`, async () => {
    const old = harness(true, response);
    const current = harness(false, response);
    const oldResult = await old.tool.execute("outcome", { action: "permissions" });
    const currentResult = await current.tool.execute("outcome", { action: "doctor" });
    const { deprecation, ...details } = oldResult.details;
    assert.match(notice(oldResult), /permissions.*doctor/);
    assert.deepEqual(details, currentResult.details);
    assert.deepEqual(old.audits[0].result, current.audits[0].result);
    assert.equal(old.audits[0].resultHash, current.audits[0].resultHash);
  });
}

test("audit failures remain visible alongside deprecation", async () => {
  const tool = createDesktopUseTool({ runAdapter: async () => ({ ok: true }), appendAuditEvent: async () => { throw new Error("audit unavailable"); } });
  const result = await tool.execute("audit-failure", { action: "permissions" });
  assert.equal(result.details.status, "success");
  assert.deepEqual(result.details.audit, { written: false, code: "AUDIT_WRITE_FAILED" });
  assert.match(notice(result), /permissions.*doctor/);
});

test("advertised schema offers only canonical actions and documents replacements", () => {
  const tool = createComputerUseTool();
  assert.equal(tool.parameters.properties.action.enum.length, 18);
  for (const { legacy, canonical } of aliases) {
    assert.ok(!(tool.parameters.properties.action.enum as readonly string[]).includes(legacy));
    assert.ok((tool.parameters.properties.action.enum as readonly string[]).includes(canonical));
    assert.match(tool.parameters.properties.action.description, new RegExp(`${legacy}.*${canonical}`));
  }
  assert.match(tool.parameters.properties.action.description, /deprecated/i);
  assert.match(createDesktopUseTool().description, /deprecated.*computer_use/i);
  assert.match(tool.parameters.properties.text.description, /deprecated.*clipboardText/i);
  assert.match(tool.parameters.properties.clipboardText.description, /clipboard-write/);
  assert.throws(() => normalizeParams({ action: "toString" }));
  assert.throws(() => normalizeParams({ action: "permissions", mode: "invalid" }));
});
