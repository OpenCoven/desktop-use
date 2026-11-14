import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { cleanSchemaForGemini } from "openclaw/plugin-sdk/provider-tools";
import { createComputerUseTool, createDesktopUseTool } from "./plugin-tool.js";

// Exercise the pinned host's actual pre-execution validator; direct execute()
// tests cannot catch aliases being rejected before plugin normalization.
const hostDirectory = dirname(realpathSync(new URL("../node_modules/openclaw/package.json", import.meta.url)));
const { validateToolArguments } = await import(pathToFileURL(join(hostDirectory, "../@mariozechner/pi-ai/dist/index.js")).href);

test("pinned host accepts legacy actions before plugin execution and preserves notices", async () => {
  for (const factory of [createComputerUseTool, createDesktopUseTool]) {
    const tool = factory({ approvalProvider: async () => "allowed" as const, runAdapter: async () => ({ ok: true }), appendAuditEvent: async () => {} });
    for (const parameters of [tool.parameters, cleanSchemaForGemini(tool.parameters)]) {
      for (const [action, canonical, extra] of [
        ["permissions", "doctor", {}],
        ["see", "inspect", {}],
        ["capture", "screenshot", {}],
        ["type", "type-text", { text: "fixture", confirm: true }],
        ["press", "keypress", { keys: ["tab"], confirm: true }],
      ] as const) {
        const args = validateToolArguments({ ...tool, parameters }, { name: tool.name, arguments: { action, ...extra } });
        const result = await tool.execute("host-alias", args);
        assert.equal(result.details.status, "success");
        assert.equal(result.details.action, canonical);
        assert.match(String(result.details.deprecation), new RegExp(`${action}.*${canonical}`));
      }
    }
  }
});

test("provider schema conversion preserves the bounded compatibility vocabulary", () => {
  for (const factory of [createComputerUseTool, createDesktopUseTool]) {
    const tool = factory();
    for (const parameters of [tool.parameters, cleanSchemaForGemini(tool.parameters)]) {
      const hostTool = { ...tool, parameters };
      const schema = parameters as { properties: { action: { description: string } } };
      assert.match(schema.properties.action.description, /permissions -> doctor/);
      assert.match(schema.properties.action.description, /Removal targeted at 0\.2\.0/);
      for (const action of ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "shell", "file-list", "file-read", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch", "permissions", "see", "capture", "type", "press"]) {
        assert.deepEqual(validateToolArguments(hostTool, { name: tool.name, arguments: { action } }), { action });
      }
      for (const action of ["unknown-action", "toString", "Doctor", "doctor "]) {
        assert.throws(() => validateToolArguments(hostTool, { name: tool.name, arguments: { action } }), /Validation failed/);
      }
    }
  }
});

test("restricted model schemas retain only eligible canonical actions and aliases after provider conversion", async () => {
  const { resolveActionPermissions } = await import("./action-permissions.js");
  const cases = [
    [{ actionProfile: "observation-only" }, ["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read", "permissions", "see", "capture"]],
    [{ actionProfile: "desktop-only" }, ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch", "permissions", "see", "capture", "type", "press"]],
    [{ allowedActions: [] }, ["stop"]],
    [{ allowedActions: ["type-text"] }, ["stop", "type-text", "type"]],
  ] as const;
  const all = ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "shell", "file-list", "file-read", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch", "permissions", "see", "capture", "type", "press", "toString", "unknown"];
  for (const factory of [createComputerUseTool, createDesktopUseTool]) for (const [config, expected] of cases) {
    const tool = factory({ actionPermissions: resolveActionPermissions(config) });
    assert.deepEqual(tool.parameters.properties.action.enum, expected);
    assert.deepEqual(tool.parameters.properties.action.anyOf.map(branch => branch.const), expected);
    if (expected.length === 1) assert.match(tool.description, /Stop-only/i);
    for (const parameters of [tool.parameters, cleanSchemaForGemini(tool.parameters)]) for (const action of all) {
      const validate = () => validateToolArguments({ ...tool, parameters }, { name: tool.name, arguments: { action } });
      if ((expected as readonly string[]).includes(action)) assert.deepEqual(validate(), { action });
      else assert.throws(validate, /Validation failed/, action);
    }
  }
});
