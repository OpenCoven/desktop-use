import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { COMPUTER_USE_AGENT } from "./computer-use-agent.js";
import {
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
  // Direct gateway HTTP calls may omit agentDir. Respect the gateway's explicit
  // state root rather than escaping an isolated gateway into the user's profile.
  const stateRoot = process.env.OPENCLAW_STATE_DIR?.trim() || resolve(homedir(), ".openclaw");
  const agentId = ctx.agentId ?? COMPUTER_USE_AGENT.id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId)) throw new Error("Audit agent id is invalid.");
  return resolve(stateRoot, "agents", agentId, "audit", "computer-use.jsonl");
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
