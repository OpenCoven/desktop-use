import { COMPUTER_USE_TOOL_NAME } from "./tool-names.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPUTER_USE_CONTROL_UI_DESCRIPTOR } from "./computer-use-agent.js";
import { createComputerUseTool } from "./plugin-tool.js";

test("the panel only offers plugin controls with executable action mappings", async t => {
  const descriptor = COMPUTER_USE_CONTROL_UI_DESCRIPTOR as any;
  assert.deepEqual(Object.keys(descriptor.schema.properties.controls.properties).sort(), ["runHealthCheck", "stop"]);
  assert.deepEqual(descriptor.actions, {
    stop: { tool: COMPUTER_USE_TOOL_NAME, args: { action: "stop" } },
    runHealthCheck: { tool: COMPUTER_USE_TOOL_NAME, args: { action: "health" } },
  });
  const root = await mkdtemp(join(tmpdir(), "desktopuse-panel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = createComputerUseTool({ ctx: { agentDir: join(root, "agent"), workspaceDir: root, sessionKey: "panel" } });
  const result = await tool.execute("panel-stop", descriptor.actions.stop.args);
  assert.equal(result.details.status, "success");
  assert.equal(result.details.state, "idle");
  const events = (await readFile(join(root, "audit/computer-use.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events[0].action, "stop");
});

test("every panel field declares its producer and availability", () => {
  const descriptor = COMPUTER_USE_CONTROL_UI_DESCRIPTOR as any;
  assert.deepEqual(Object.keys(descriptor.stateSources ?? {}).sort(), Object.keys(descriptor.schema.properties).sort());
  for (const field of Object.keys(descriptor.schema.properties)) {
    const source = descriptor.stateSources[field];
    assert.ok(["plugin", "host"].includes(source.owner), field);
    assert.equal(typeof source.source, "string", field);
    assert.ok(source.source.length > 0, field);
    assert.equal(typeof source.availability, "string", field);
    assert.ok(source.availability.length > 0, field);
  }
  assert.equal(descriptor.stateSources.pendingApprovals.owner, "host");
  assert.equal(descriptor.stateSources.activeTarget.owner, "host");
  assert.equal(descriptor.stateSources.recentActions.owner, "host");
});
