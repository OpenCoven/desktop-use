import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMPUTER_USE_AGENT,
  COMPUTER_USE_CONTROL_UI_DESCRIPTOR,
  COMPUTER_USE_HEALTH_CHECK,
} from "./computer-use-agent.js";

test("defines a dedicated computer-use agent identity and state roots", () => {
  assert.equal(COMPUTER_USE_AGENT.id, "computer-use");
  assert.match(COMPUTER_USE_AGENT.identityMarkdown, /local machine operator/i);
  assert.match(COMPUTER_USE_AGENT.identityMarkdown, /no hidden automation/i);
  assert.match(COMPUTER_USE_AGENT.workspace, /computer-use/);
  assert.match(COMPUTER_USE_AGENT.agentDir, /computer-use/);
  assert.match(COMPUTER_USE_AGENT.memory.store, /computer-use/);
  assert.match(COMPUTER_USE_AGENT.auditLog, /computer-use.*audit.*jsonl/);
});

test("keeps the dedicated agent tool policy narrow", () => {
  assert.deepEqual(COMPUTER_USE_AGENT.toolPolicy.allow, ["computer_use"]);
  assert.equal(COMPUTER_USE_AGENT.toolPolicy.profile, "minimal");
  assert.equal(COMPUTER_USE_AGENT.auth.inheritsMainOAuth, true);
  assert.equal(COMPUTER_USE_AGENT.auth.copyOAuthSecrets, false);
});

test("describes the Control UI state expected by the Computer Use panel", () => {
  assert.equal(COMPUTER_USE_CONTROL_UI_DESCRIPTOR.id, "computer-use-panel");
  assert.equal(COMPUTER_USE_CONTROL_UI_DESCRIPTOR.surface, "settings");
  assert.equal(COMPUTER_USE_CONTROL_UI_DESCRIPTOR.label, "Computer Use");

  const schema = COMPUTER_USE_CONTROL_UI_DESCRIPTOR.schema as {
    properties: Record<string, unknown>;
  };
  for (const field of [
    "health",
    "permissions",
    "activeTarget",
    "latestObservation",
    "pendingApprovals",
    "recentActions",
    "errors",
    "repairHints",
    "controls",
  ]) {
    assert.ok(schema.properties[field], `missing ${field}`);
  }
});

test("declares a real health check command for local verification", () => {
  assert.equal(COMPUTER_USE_HEALTH_CHECK.tool, "computer_use");
  assert.deepEqual(COMPUTER_USE_HEALTH_CHECK.args, { action: "health" });
});

test("ships a packaged identity and config template for the dedicated agent", () => {
  const identity = readFileSync(
    new URL("../agents/computer-use/IDENTITY.md", import.meta.url),
    "utf8",
  );
  const config = JSON.parse(
    readFileSync(new URL("../agents/computer-use/openclaw-agent.json", import.meta.url), "utf8"),
  ) as {
    id: string;
    tools: { allow: string[]; deny: string[] };
    health: { tool: string; args: Record<string, unknown> };
  };

  assert.match(identity, /No hidden automation/);
  assert.equal(config.id, "computer-use");
  assert.deepEqual(config.tools.allow, ["computer_use"]);
  assert.ok(config.tools.deny.includes("shell"));
  assert.equal(config.health.tool, "computer_use");
  assert.deepEqual(config.health.args, { action: "health" });
});
