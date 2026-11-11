import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { COMPUTER_USE_AGENT, COMPUTER_USE_HEALTH_CHECK } from "./computer-use-agent.js";
import { createComputerUseTool, createDesktopUseTool } from "./plugin-tool.js";
import {
  COMPUTER_USE_TOOL_NAME,
  COMPUTER_USE_TOOL_NAMES,
  DESKTOP_USE_TOOL_NAME,
  isComputerUseToolName,
} from "./tool-names.js";

const root = new URL("../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

test("the tool definitions carry the exported names", () => {
  assert.equal(createComputerUseTool().name, COMPUTER_USE_TOOL_NAME);
  assert.equal(createDesktopUseTool().name, DESKTOP_USE_TOOL_NAME);
  assert.notEqual(COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME);
  for (const name of COMPUTER_USE_TOOL_NAMES) assert.equal(isComputerUseToolName(name), true);
  for (const other of ["", "exec", `${COMPUTER_USE_TOOL_NAME} `, undefined, 1]) {
    assert.equal(isComputerUseToolName(other), false);
  }
});

test("openclaw.plugin.json contracts list exactly the exported tool names", () => {
  const manifest = readJson("openclaw.plugin.json") as { contracts: { tools: string[] } };
  assert.deepEqual(manifest.contracts.tools, [...COMPUTER_USE_TOOL_NAMES]);
});

test("the packaged agent template allows and health-checks only the canonical tool", () => {
  const template = readJson("agents/computer-use/openclaw-agent.json") as {
    tools: { allow: string[]; deny: string[] };
    health: { tool: string; args: Record<string, unknown> };
  };
  assert.deepEqual(template.tools.allow, [COMPUTER_USE_TOOL_NAME]);
  assert.deepEqual(template.tools.allow, [...COMPUTER_USE_AGENT.toolPolicy.allow]);
  assert.equal(template.tools.deny.includes(DESKTOP_USE_TOOL_NAME), false);
  assert.deepEqual(template.health, COMPUTER_USE_HEALTH_CHECK);
});

test("no TypeScript source spells a tool name outside the constants module", () => {
  const spelled = new RegExp(COMPUTER_USE_TOOL_NAMES.join("|"));
  const sources = ["index.ts", ...readdirSync(new URL("src/", root)).filter(name => name.endsWith(".ts")).map(name => `src/${name}`)];
  assert.ok(sources.includes("src/plugin-tool.ts"));
  const offenders = sources
    .filter(path => path !== "src/tool-names.ts")
    .filter(path => spelled.test(readFileSync(new URL(path, root), "utf8")));
  assert.deepEqual(offenders, []);
});
