import type { CapabilityReportV1 } from '../capabilities.js';
import { summarizeCapabilities } from '../capability-summary.js';
import type { DesktopResult } from '../core/client.js';

/**
 * Compact-JSON byte budget for every connector-shaped MCP result, on both carriers (ADR 0002, #52). It is 69% of the
 * smallest measured harness limit: Codex CLI 0.169.0 without catalog metadata delivers 11,926 B intact.
 */
export const MCP_RESULT_BUDGET_BYTES = 8192;

const DISCOVERY_ACTIONS = new Set(['health', 'doctor']);

/**
 * Projects a core result onto the MCP surface. Discovery carries capabilitySummaryV1 in place of the full report,
 * the adapter's duplicate raw report and the OpenClaw agent profile. The text carrier is compact JSON of
 * structuredContent for every result; images pass through unchanged.
 */
export function projectMcpResult(result: DesktopResult): { content: DesktopResult['content']; structuredContent: DesktopResult['details'] } {
  const details = DISCOVERY_ACTIONS.has(String(result.details.action)) ? compactDiscovery(result.details) : result.details;
  const [, ...images] = result.content;
  return { content: [{ type: 'text', text: JSON.stringify(details) }, ...images], structuredContent: details };
}

function compactDiscovery(details: DesktopResult['details']): DesktopResult['details'] {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(details)) {
    if (key === 'agent') continue;
    if (key === 'capabilitiesV1') entries.push(['capabilitySummaryV1', summarizeCapabilities(value as CapabilityReportV1)]);
    else if (key === 'result' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const { capabilitiesV1: _raw, ...envelope } = value as Record<string, unknown>;
      entries.push([key, envelope]);
    } else entries.push([key, value]);
  }
  return Object.fromEntries(entries) as DesktopResult['details'];
}
