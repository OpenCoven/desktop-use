import assert from "node:assert/strict";
import test from "node:test";
import { COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME } from "./tool-names.js";
import plugin from "../index.js";

test("registers the canonical tool, its legacy alias, Control UI descriptor, and approval hook", async () => {
  const tools: Array<{ opts?: { name?: string; optional?: boolean } }> = [];
  const descriptors: unknown[] = [];
  const metadata: unknown[] = [];
  const hooks: Array<{ name: string; handler: (event: any, ctx: any) => unknown }> = [];

  plugin.register({
    id: "opencoven-desktop-use",
    name: "OpenCoven Desktop Use",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {},
    logger: console,
    registerTool(_tool: unknown, opts?: { name?: string; optional?: boolean }) {
      tools.push({ opts });
    },
    registerToolMetadata(entry: unknown) {
      metadata.push(entry);
    },
    registerControlUiDescriptor(descriptor: unknown) {
      descriptors.push(descriptor);
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      hooks.push({ name, handler });
    },
  } as never);

  assert.deepEqual(
    tools.map((entry) => entry.opts),
    [{ name: COMPUTER_USE_TOOL_NAME }, { name: DESKTOP_USE_TOOL_NAME, optional: true }],
  );
  assert.equal(metadata.length, 2);
  assert.equal(descriptors.length, 1);
  assert.equal(hooks[0]?.name, "before_tool_call");

  const approval = await hooks[0]?.handler(
    { toolName: COMPUTER_USE_TOOL_NAME, params: { action: "click", on: "B1" } },
    { agentId: "computer-use", sessionKey: "agent:computer-use:main" },
  ) as { params?: { confirm?: boolean }; requireApproval?: { title?: string } };
  assert.equal(approval.params?.confirm, true);
  assert.match(approval.requireApproval?.title ?? "", /Click/);

  for (const toolName of [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME]) {
    for (const params of [{ action: "click" }, { action: "type-text" }, { action: "keypress", keys: [""] }, { action: "scroll" }, { action: "focus" }, { action: "shell" }, { action: "file-read" }, { action: "clipboard-write" }, { action: "browser-open" }, { action: "app-launch" }, null, { action: 1 }, { action: "click", confirm: "true" }, { action: "keypress", keys: ["a".repeat(1024), "b".repeat(1024)] }]) {
      const invalid = await hooks[0]?.handler({ toolName, params }, {}) as { block?: boolean };
      assert.equal(invalid.block, true);
    }
  }

  const blocked = await hooks[0]?.handler(
    {
      toolName: COMPUTER_USE_TOOL_NAME,
      params: { action: "shell", command: "tccutil", args: ["reset", "Accessibility"] },
    },
    { agentId: "computer-use", sessionKey: "agent:computer-use:main" },
  ) as { block?: boolean; blockReason?: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason ?? "", /security boundary/i);
});
