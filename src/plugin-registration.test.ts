import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";

test("registers computer_use, legacy desktop_use, Control UI descriptor, and approval hook", () => {
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
    [{ name: "computer_use" }, { name: "desktop_use", optional: true }],
  );
  assert.equal(metadata.length, 2);
  assert.equal(descriptors.length, 1);
  assert.equal(hooks[0]?.name, "before_tool_call");

  const approval = hooks[0]?.handler(
    { toolName: "computer_use", params: { action: "click", on: "B1" } },
    { agentId: "computer-use", sessionKey: "agent:computer-use:main" },
  ) as { params?: { confirm?: boolean }; requireApproval?: { title?: string } };
  assert.equal(approval.params?.confirm, true);
  assert.match(approval.requireApproval?.title ?? "", /Click/);

  const blocked = hooks[0]?.handler(
    {
      toolName: "computer_use",
      params: { action: "shell", command: "tccutil", args: ["reset", "Accessibility"] },
    },
    { agentId: "computer-use", sessionKey: "agent:computer-use:main" },
  ) as { block?: boolean; blockReason?: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason ?? "", /security boundary/i);
});
