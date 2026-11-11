import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  COMPUTER_USE_CONTROL_UI_DESCRIPTOR,
} from "./src/computer-use-agent.js";
import {
  type ComputerUseParams,
  type ComputerUsePolicyContext,
  normalizeComputerUseAction,
} from "./src/computer-use-policy.js";
import { createComputerUseTool, createDesktopUseTool, normalizeParams, prepareComputerUseRequest } from "./src/plugin-tool.js";

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
    // Hook contexts omit workspaceDir in this SDK. Retain the authenticated tool-factory context.
    const policyContexts = new Map<string, ComputerUsePolicyContext>();
    const scope = (ctx: ComputerUsePolicyContext) => JSON.stringify([ctx.agentId ?? "computer-use", ctx.sessionKey ?? ""]);
    const remember = (ctx: ComputerUsePolicyContext) => {
      const snapshot = { ...ctx }; const key = scope(snapshot);
      policyContexts.delete(key); policyContexts.set(key, snapshot);
      if (policyContexts.size > 256) policyContexts.delete(policyContexts.keys().next().value!);
      return snapshot;
    };
    api.registerTool((ctx) => createComputerUseTool({ ctx: remember(ctx) }), { name: "computer_use" });
    api.registerTool((ctx) => createDesktopUseTool({ ctx: remember(ctx) }), {
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
      description: "Deprecated alias for computer_use; removal targeted at 0.2.0.",
    });
    optionalApi.registerControlUiDescriptor?.(COMPUTER_USE_CONTROL_UI_DESCRIPTOR);
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (event.toolName !== "computer_use" && event.toolName !== "desktop_use") {
          return undefined;
        }
        let params: ComputerUseParams;
        try {
          params = normalizeParams(event.params);
        } catch {
          return { block: true, blockReason: "Invalid computer-use parameters." };
        }
        const action = normalizeComputerUseAction(params.action);
        const candidates = [...policyContexts.values()].filter(value => (value.agentId ?? "computer-use") === (ctx.agentId ?? "computer-use"));
        const known = policyContexts.get(scope(ctx)) ?? (new Set(candidates.map(value => value.workspaceDir)).size === 1 ? candidates[0] : undefined);
        const fileAction = ["file-list", "file-read", "file-write"].includes(action) || (["inspect", "screenshot"].includes(action) && params.path);
        if (fileAction && !known?.workspaceDir) return { block: true, blockReason: "Computer-use workspace context is unavailable; file approval cannot be established." };
        let prepared;
        try { prepared = await prepareComputerUseRequest(params, { ...known, agentId: ctx.agentId, sessionKey: ctx.sessionKey }); }
        catch { return { block: true, blockReason: "Computer-use target could not be resolved safely." }; }
        params = prepared.params;
        const decision = prepared.decision;
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
        return fileAction ? { params } : undefined;
      },
      { priority: 100 },
    );
  },
});
