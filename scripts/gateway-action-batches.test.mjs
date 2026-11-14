import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_ACTIONS, LEGACY_ACTION_ALIASES } from "../src/computer-use-actions.ts";
import { buildRestrictedBatch, batchCallId, callName } from "./gateway-action-batches.mjs";

const fixtures = {
  health: {}, doctor: {}, inspect: {}, screenshot: {}, click: { on: "B1" },
  "type-text": { text: "private-fixture" }, keypress: { keys: ["tab"] }, scroll: { direction: "down" }, focus: { app: "fixture" },
  shell: { command: "fixture" }, "file-list": { path: "." }, "file-read": { path: "observation.txt" },
  "file-write": { path: "forbidden.txt", content: "private-fixture" }, "clipboard-read": {}, "clipboard-write": { clipboardText: "private-fixture" },
  "browser-open": { url: "https://example.invalid" }, "app-launch": { app: "fixture" },
};
const profiles = {
  "observation-only": ["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read"],
  "desktop-only": ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch"],
  "stop-only": ["stop"],
};

test("restricted batches submit every compatible action exactly once, with a separate Stop and matching approval ids", () => {
  for (const [profile, eligible] of Object.entries(profiles)) {
    const batch = buildRestrictedBatch(eligible, fixtures);
    const submitted = [...batch.calls.map(call => call.args.action), "stop"];
    assert.deepEqual([...submitted].sort(), [...CANONICAL_ACTIONS, ...Object.keys(LEGACY_ACTION_ALIASES)].sort(), `${profile}: missing or duplicate vocabulary`);
    const ids = [...batch.calls.map(call => batchCallId(call.name)), batchCallId(callName("allowed", "stop"))];
    assert.equal(new Set(ids).size, 23);
    assert.equal(batch.calls.some(call => call.args.action === "stop"), false);
    assert.deepEqual(batch.approvalCalls, batch.calls.filter(call => batch.gatedActions.includes(call.args.action)).map(call => call.name));
    assert.equal(new Set(batch.approvalCalls.map(batchCallId)).size, batch.gatedActions.length);
    for (const call of batch.calls) {
      const canonical = LEGACY_ACTION_ALIASES[call.args.action] ?? call.args.action;
      assert.equal(batch.deniedActions.includes(call.args.action), !eligible.includes(canonical));
      assert.deepEqual(call.args, { action: call.args.action, ...fixtures[canonical], ...(batch.allowedActions.includes(call.args.action) ? {} : { confirm: true }) });
    }
  }
});

test("desktop batch gates all canonical inputs and legacy inputs despite model confirmation, and invokes observation aliases", () => {
  const batch = buildRestrictedBatch(profiles["desktop-only"], fixtures);
  assert.deepEqual([...batch.gatedActions].sort(), ["click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch", "type", "press"].sort());
  for (const action of ["click", "type-text", "keypress", "scroll", "focus", "type", "press"]) {
    const call = batch.calls.find(call => call.args.action === action);
    assert.ok(call, `Missing canonical/legacy input ${action}`);
    assert.equal(call.args.confirm, true);
    assert.ok(batch.approvalCalls.includes(call.name), `Unresolved input ${action}`);
  }
  for (const action of ["permissions", "see", "capture"]) assert.ok(batch.allowedActions.includes(action), `Missing observation alias ${action}`);
});
