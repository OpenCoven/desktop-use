import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  COMPUTER_USE_CONTROL_UI_DESCRIPTOR,
} from "./src/computer-use-agent.js";
import {
  classifyComputerUseRequest,
  type ComputerUseParams,
} from "./src/computer-use-policy.js";
import { createComputerUseTool, createDesktopUseTool } from "./src/plugin-tool.js";

type OptionalComputerUseApi = {
  registerToolMetadata?: (metadata: {
    toolName: string;
    displayName?: string;
    description?: string;
    risk?: "low" | "medium" | "high";
    tags?: string[];
  }) => void;
  registerControlUiDescriptor?: (descriptor: typeof COMPUTER_USE_CONTROL_UI_DESCRIPTOR) => void;
};

export default definePluginEntry({
  id: "opencoven-desktop-use",
  name: "OpenCoven Desktop Use",
  description:
    "Registers the dedicated computer_use agent tool and delegates desktop automation to the external OpenCoven coven-desktop-use adapter.",
  register(api) {
    const optionalApi = api as typeof api & OptionalComputerUseApi;
    api.registerTool((ctx) => createComputerUseTool({ ctx }), { name: "computer_use" });
    api.registerTool((ctx) => createDesktopUseTool({ ctx }), {
      name: "desktop_use",
      optional: true,
    });
    optionalApi.registerToolMetadata?.({
      toolName: "computer_use",
      displayName: "Computer Use",
      risk: "high",
      tags: ["opencoven", "computer-use", "approval-gated"],
      description:
        "Dedicated OpenCoven computer-use tool with policy, approval, audit, and health boundaries.",
    });
    optionalApi.registerToolMetadata?.({
      toolName: "desktop_use",
      displayName: "Desktop Use",
      risk: "high",
      tags: ["opencoven", "computer-use", "legacy"],
      description: "Legacy alias for computer_use.",
    });
    optionalApi.registerControlUiDescriptor?.(COMPUTER_USE_CONTROL_UI_DESCRIPTOR);
    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (event.toolName !== "computer_use" && event.toolName !== "desktop_use") {
          return undefined;
        }
        const params = event.params as ComputerUseParams;
        const decision = classifyComputerUseRequest(params, {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
        if (decision.status === "blocked") {
          return {
            block: true,
            blockReason: decision.reason ?? "Computer Use policy blocked this action.",
          };
        }
        if (decision.status === "needsApproval" && decision.approvalPrompt) {
          return {
            params: { ...params, confirm: true },
            requireApproval: {
              title: decision.approvalPrompt.title,
              description: [
                decision.approvalPrompt.description,
                `Risk: ${decision.approvalPrompt.risk}.`,
                decision.approvalPrompt.exactInput
                  ? `Exact input: ${decision.approvalPrompt.exactInput}`
                  : "",
                decision.approvalPrompt.rollback
                  ? `Rollback: ${decision.approvalPrompt.rollback}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
              severity: decision.approvalPrompt.severity,
              timeoutMs: 5 * 60 * 1000,
              timeoutBehavior: "deny",
            },
          };
        }
        return undefined;
      },
      { priority: 100 },
    );
  },
});
