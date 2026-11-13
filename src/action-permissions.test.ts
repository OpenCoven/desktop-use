import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../index.js";

import * as permissions from "./action-permissions.js";
const full = ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "shell", "file-list", "file-read", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch"];
const observation = ["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read"];

test("trusted permissions resolve defaults, preset intersections and Stop-only in canonical order", () => {
  const { resolveActionPermissions: resolve, isActionAllowed } = permissions;
  assert.deepEqual(resolve().allowedActions, full);
  assert.deepEqual(resolve({ actionProfile: "full" }).allowedActions, full);
  assert.deepEqual(resolve({ actionProfile: "observation-only" }).allowedActions, observation);
  assert.deepEqual(resolve({ actionProfile: "desktop-only" }).allowedActions, ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch"]);
  assert.deepEqual(resolve({ actionProfile: "observation-only", allowedActions: ["file-read", "click", "doctor"] }).allowedActions, ["stop", "doctor", "file-read"]);
  assert.deepEqual(resolve({ allowedActions: [] }).allowedActions, ["stop"]);
  assert.equal(isActionAllowed(resolve({ allowedActions: ["doctor"] }), "permissions"), true);
  for (const action of ["constructor", "toString", "__proto__", "unknown", "type"]) assert.equal(isActionAllowed(resolve({ allowedActions: [] }), action), false);
});

test("invalid config never silently widens into full permissions", () => {
  const inherited = Object.create({ actionProfile: "full" });
  for (const config of [null, [], "full", 0, { actionProfile: "constructor" }, { actionProfile: "unknown" }, { actionProfile: undefined }, { allowedActions: undefined }, { allowedActions: null }, { allowedActions: "stop" }, { allowedActions: ["stop", "stop"] }, { allowedActions: ["type"] }, { allowedActions: ["permissions"] }, { allowedActions: ["see"] }, { allowedActions: ["capture"] }, { allowedActions: ["press"] }, { allowedActions: ["constructor"] }, { allowedActions: ["toString"] }, { allowedActions: ["__proto__"] }, { allowedActions: ["unknown"] }, { allowedActions: [1] }, { allowActions: [] }, JSON.parse('{"__proto__":{}}'), inherited]) {
    assert.throws(() => permissions.resolveActionPermissions(config), /Invalid action permissions/);
  }
});

test("permission snapshots are immutable and have stable profile identities", () => {
  const config = { actionProfile: "observation-only", allowedActions: ["doctor", "inspect"] };
  const snapshot = permissions.resolveActionPermissions(config);
  config.allowedActions.push("shell"); config.actionProfile = "full";
  assert.deepEqual(snapshot.allowedActions, ["stop", "doctor", "inspect"]);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.allowedActions), true);
  assert.throws(() => (snapshot.allowedActions as string[]).push("shell"), TypeError);
  assert.match(snapshot.snapshotId, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.snapshotId, permissions.resolveActionPermissions({ actionProfile: "observation-only", allowedActions: ["inspect", "doctor"] }).snapshotId);
  assert.notEqual(snapshot.snapshotId, permissions.resolveActionPermissions({ allowedActions: ["inspect", "doctor"] }).snapshotId);
});

test("manifest and public SDK entry advertise and validate the same trusted config", async () => {
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.configSchema, permissions.ACTION_PERMISSIONS_CONFIG_SCHEMA);
  assert.deepEqual(plugin.configSchema.jsonSchema, manifest.configSchema);
  assert.equal(plugin.configSchema.safeParse?.({ actionProfile: "observation-only", allowedActions: [] }).success, true);
  for (const value of [{ unknown: true }, { allowedActions: ["see"] }, { allowedActions: ["stop", "stop"] }]) assert.equal(plugin.configSchema.safeParse?.(value).success, false);
});
