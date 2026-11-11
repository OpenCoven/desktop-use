import { COMPUTER_USE_AGENT } from "./computer-use-agent.js";
import type { ComputerUsePolicyContext } from "./computer-use-policy.js";

/**
 * Identifies which calls belong together, for both the approval hook and stop.
 *
 * A missing agent id means the dedicated agent. A missing session key is its
 * own scope: it is encoded as null, so it can never equal a real key such as
 * "" or "default".
 *
 * - "session" is [agent, session]. The approval hook uses it because the SDK's
 *   hook context carries no workspaceDir to compare.
 * - "call" adds the workspace. Stop uses it so it only cancels calls from the
 *   same agent, session, and workspace.
 */
export function computerUseScopeKey(ctx: ComputerUsePolicyContext, granularity: "session" | "call"): string {
  const session = [ctx.agentId ?? COMPUTER_USE_AGENT.id, ctx.sessionKey ?? null];
  return JSON.stringify(granularity === "call" ? [...session, ctx.workspaceDir ?? null] : session);
}
