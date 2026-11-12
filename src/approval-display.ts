import { normalizeComputerUseAction, redactComputerUseValue, type ComputerUseDecision, type ComputerUseParams } from "./computer-use-policy.js";

// OpenClaw 2026.4.26 limits approval titles to 80 Unicode characters and
// descriptions to 256. Never silently shorten a target or executable input.
const fits = (value: string, limit: number) => Array.from(value).length <= limit;

export function gatewayApprovalDisplay(params: ComputerUseParams, decision: ComputerUseDecision) {
  const prompt = decision.approvalPrompt;
  if (!prompt) return undefined;
  const shell = normalizeComputerUseAction(params.action) === "shell";
  const input = shell
    ? { args: params.args ?? [], ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}) }
    : Object.fromEntries(Object.entries(params).filter(([key]) => !["action", "confirm", "reason", "path", "cwd"].includes(key)));
  const details = JSON.stringify(redactComputerUseValue(input));
  let title = shell ? `Run ${JSON.stringify(params.command)}` : prompt.title;
  if (prompt.rollback && fits(`${title} (manual rollback)`, 80)) title += " (manual rollback)";
  const description = `Risk: ${prompt.risk}. Target: ${JSON.stringify(prompt.target)}${details === "{}" ? "" : `. Input: ${details}`}`;
  if (!fits(title, 80) || !fits(description, 256)) return undefined;
  return { title, description, severity: prompt.severity };
}
