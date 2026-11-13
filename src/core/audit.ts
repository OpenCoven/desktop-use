import { createHash } from "node:crypto";
import {
  type ComputerUseDecision,
  type ComputerUseParams,
  type ComputerUsePolicyContext,
} from "../computer-use-policy.js";

export type ComputerUseAuditEvent = {
  timestamp: string;
  agentId: string;
  sessionKey?: string;
  toolCallId?: string;
  action: string;
  target: string;
  risk: string;
  approvalId?: string;
  params: unknown;
  result: {
    status: string;
    success: boolean;
    code?: string | number;
  };
  resultHash: string;
};

export function buildComputerUseAuditEvent(params: {
  toolCallId?: string;
  request: ComputerUseParams;
  decision: ComputerUseDecision;
  result: { status: string; success?: boolean; code?: string | number };
  ctx?: ComputerUsePolicyContext;
  approvalId?: string;
  now?: Date;
}): ComputerUseAuditEvent {
  // Arbitrary paths, URLs, titles, argv, and free-form reasons can contain secrets too.
  const summarize = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map(item => summarize(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v, k)]));
    if (typeof value !== "string") return value;
    if (key === "action") return params.decision.normalizedAction;
    return `<${Buffer.byteLength(value, "utf8")}-byte ${["text", "clipboardText", "content"].includes(key) ? "text" : "value"}>`;
  };
  const redactedParams = summarize(params.request);
  const resultSummary = {
    status: params.result.status,
    success: params.result.success === true,
    ...(params.result.code !== undefined ? { code: params.result.code } : {}),
  };
  return {
    timestamp: (params.now ?? new Date()).toISOString(),
    agentId: params.ctx?.agentId ?? "computer-use",
    ...(params.ctx?.sessionKey ? { sessionKey: params.ctx.sessionKey } : {}),
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    action: params.decision.normalizedAction,
    target: `<${Buffer.byteLength(params.decision.target, "utf8")}-byte target>`,
    risk: params.decision.risk,
    ...(params.approvalId ? { approvalId: params.approvalId } : {}),
    params: redactedParams,
    result: resultSummary,
    resultHash: createHash("sha256").update(JSON.stringify(resultSummary)).digest("hex"),
  };
}
