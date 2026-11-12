import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { gatewayApprovalDisplay } from "./src/approval-display.js";
import {
  COMPUTER_USE_CONTROL_UI_DESCRIPTOR,
} from "./src/computer-use-agent.js";
import {
  type ComputerUseParams,
  type ComputerUsePolicyContext,
  normalizeComputerUseAction,
  classifyComputerUseRequest,
} from "./src/computer-use-policy.js";
import { computerUseScopeKey } from "./src/computer-use-scope.js";
import { createComputerUseTool, createDesktopUseTool, normalizeParams, prepareComputerUseRequest } from "./src/plugin-tool.js";
import { COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME, isComputerUseToolName } from "./src/tool-names.js";

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
    `Registers the dedicated ${COMPUTER_USE_TOOL_NAME} agent tool and delegates desktop automation to the external OpenCoven coven-desktop-use adapter.`,
  register(api) {
    const optionalApi = api as typeof api & OptionalComputerUseApi;
    // Hook contexts omit workspaceDir in this SDK. Retain the authenticated tool-factory context.
    const policyContexts = new Map<string, ComputerUsePolicyContext | undefined>();
    const scope = (ctx: ComputerUsePolicyContext) => computerUseScopeKey(ctx, "session");
    const remember = (ctx: ComputerUsePolicyContext) => {
      const snapshot = { ...ctx }; const key = scope(snapshot);
      const previous = policyContexts.get(key);
      // The SDK hook has no workspace identity to distinguish conflicting factories.
      // Keep a conflict fail-closed until this bounded entry is evicted or the plugin reloads.
      const conflict = policyContexts.has(key) && (!previous || previous.workspaceDir !== snapshot.workspaceDir);
      policyContexts.delete(key); policyContexts.set(key, conflict ? undefined : snapshot);
      if (policyContexts.size > 256) policyContexts.delete(policyContexts.keys().next().value!);
      return snapshot;
    };
    api.registerTool((ctx) => createComputerUseTool({ ctx: remember(ctx) }), { name: COMPUTER_USE_TOOL_NAME });
    api.registerTool((ctx) => createDesktopUseTool({ ctx: remember(ctx) }), {
      name: DESKTOP_USE_TOOL_NAME,
      optional: true,
    });
    optionalApi.registerToolMetadata?.({
      toolName: COMPUTER_USE_TOOL_NAME,
      displayName: "Computer Use",
      risk: "high",
      tags: ["opencoven", "computer-use", "approval-gated"],
      description:
        "Dedicated OpenCoven computer-use tool with policy, approval, audit, and health boundaries.",
    });
    optionalApi.registerToolMetadata?.({
      toolName: DESKTOP_USE_TOOL_NAME,
      displayName: "Desktop Use",
      risk: "high",
      tags: ["opencoven", "computer-use", "approval-gated", "legacy"],
      description: `Deprecated alias for ${COMPUTER_USE_TOOL_NAME}; removal targeted at 0.2.0.`,
    });
    optionalApi.registerControlUiDescriptor?.(COMPUTER_USE_CONTROL_UI_DESCRIPTOR);
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!isComputerUseToolName(event.toolName)) {
          return undefined;
        }
        let params: ComputerUseParams;
        try {
          params = normalizeParams(event.params);
          // Hook input is model-controlled. Only the gateway may apply confirm:true
          // from our returned params after it resolves requireApproval.
          params = { ...params, confirm: false };
        } catch {
          return { block: true, blockReason: "Invalid computer-use parameters." };
        }
        const action = normalizeComputerUseAction(params.action);
        const known = policyContexts.get(scope(ctx));
        const policyContext = { ...known, agentId: ctx.agentId, sessionKey: ctx.sessionKey };
        const preliminary = classifyComputerUseRequest(params, policyContext);
        if (preliminary.status === "blocked") return { block: true, blockReason: preliminary.reason };
        const scopedAction = ["shell", "file-list", "file-read", "file-write"].includes(action) || (["inspect", "screenshot"].includes(action) && params.path);
        if (scopedAction && !known?.workspaceDir) return { block: true, blockReason: "Computer-use workspace context is missing or ambiguous; target approval cannot be established." };
        let prepared;
        try { prepared = await prepareComputerUseRequest(params, policyContext); }
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
          const display = gatewayApprovalDisplay(params, decision);
          if (!display) return { block: true, blockReason: "Approval cannot display the complete target and input; shorten the request before retrying." };
          return {
            params: { ...params, confirm: true },
            requireApproval: {
              ...display,
              timeoutMs: 5 * 60 * 1000,
              timeoutBehavior: "deny",
            },
          };
        }
        return scopedAction ? { params } : undefined;
      },
      { priority: 100 },
    );
  },
});
