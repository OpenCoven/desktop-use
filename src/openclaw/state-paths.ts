import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { COMPUTER_USE_AGENT } from "../computer-use-agent.js";
import type { ComputerUseAuditEvent } from "../core/audit.js";
import type { ComputerUsePolicyContext } from "../computer-use-policy.js";

export function resolveComputerUseAuditLogPath(ctx: ComputerUsePolicyContext = {}): string {
  if (ctx.agentDir) {
    const agentRoot = ctx.agentDir.endsWith("/agent") ? dirname(ctx.agentDir) : ctx.agentDir;
    return resolve(agentRoot, "audit", "computer-use.jsonl");
  }
  // Direct gateway HTTP calls may omit agentDir. Respect the gateway's explicit
  // state root rather than escaping an isolated gateway into the user's profile.
  const stateRoot = resolveStateDir();
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

