import type { CapabilityReportV1 } from '../capabilities.js';
import { summarizeCapabilities } from '../capability-summary.js';
import type { DesktopResult } from '../core/client.js';

export const MCP_RESULT_BUDGET_BYTES = 8192;

const DISCOVERY_ACTIONS = new Set(['health', 'doctor']);

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
