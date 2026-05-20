import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  redactComputerUseValue,
  type ComputerUseDecision,
  type ComputerUseParams,
  type ComputerUsePolicyContext,
} from "./computer-use-policy.js";

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

export function resolveComputerUseAuditLogPath(ctx: ComputerUsePolicyContext = {}): string {
  if (ctx.agentDir) {
    const agentRoot = ctx.agentDir.endsWith("/agent") ? dirname(ctx.agentDir) : ctx.agentDir;
    return resolve(agentRoot, "audit", "computer-use.jsonl");
  }
  return resolve(homedir(), ".openclaw", "agents", "computer-use", "audit", "computer-use.jsonl");
}

export async function appendComputerUseAuditEvent(
  event: ComputerUseAuditEvent,
  ctx: ComputerUsePolicyContext = {},
): Promise<{ path: string; written: true }> {
  const auditPath = resolveComputerUseAuditLogPath(ctx);
  await fs.mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return { path: auditPath, written: true };
}

export function buildComputerUseAuditEvent(params: {
  toolCallId?: string;
  request: ComputerUseParams;
  decision: ComputerUseDecision;
  result: { status: string; success?: boolean; code?: string | number };
  ctx?: ComputerUsePolicyContext;
  approvalId?: string;
  now?: Date;
}): ComputerUseAuditEvent {
  const redactedParams = redactComputerUseValue(params.request);
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
    target: params.decision.target,
    risk: params.decision.risk,
    ...(params.approvalId ? { approvalId: params.approvalId } : {}),
    params: redactedParams,
    result: resultSummary,
    resultHash: createHash("sha256").update(JSON.stringify(resultSummary)).digest("hex"),
  };
}
