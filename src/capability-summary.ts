import { discoverCapabilityControls, type CapabilityReportV1 } from "./capabilities.js";

type Report = CapabilityReportV1;
type ReportAction = Report["actions"][keyof Report["actions"]];

/** One action of a capability summary: the report's own fields plus derived eligibility. */
export type CapabilitySummaryActionV1 = Pick<ReportAction, "state" | "surfaces" | "policy" | "reasonCodes"> & {
  enabled: boolean;
  modes?: NonNullable<ReportAction["variants"][number]["mode"]>[];
  selectors?: string[];
  providers: string[];
};

/**
 * Compact, model-facing projection of a v1 capabilities report (ADR 0002, #52). Every field is copied or derived
 * from the report; nothing is inferred. Hosts that need variant limits and evidence read the full report.
 */
export type CapabilitySummaryV1 = Pick<Report, "schemaVersion" | "producer" | "environment"> & {
  adapter?: { version: string | null };
  actionPermissions?: Report["actionPermissions"];
  actions: Record<keyof Report["actions"], CapabilitySummaryActionV1>;
  omitted: { capabilitiesV1: "tool-output-budget"; fullReportSurfaces: ("sdk" | "plugin" | "cli")[] };
};

const unique = <T>(values: T[]) => [...new Set(values)];

export function summarizeCapabilities(report: Report): CapabilitySummaryV1 {
  // The reference consumer validates the report and owns the eligibility rule.
  const enabled = new Map(discoverCapabilityControls(report).map(control => [control.action, control.enabled]));
  const actions = Object.fromEntries(Object.entries(report.actions).map(([name, action]) => {
    const modes = unique(action.variants.map(variant => variant.mode).filter(mode => mode !== null));
    const selectors = unique(action.variants.flatMap(variant => variant.selectors));
    return [name, {
      state: action.state, enabled: enabled.get(name as keyof Report["actions"]) === true, surfaces: action.surfaces, policy: action.policy, reasonCodes: action.reasonCodes,
      ...(modes.length ? { modes } : {}), ...(selectors.length ? { selectors } : {}),
      providers: unique(action.variants.map(variant => variant.provider.name)),
    } satisfies CapabilitySummaryActionV1];
  })) as CapabilitySummaryV1["actions"];
  return {
    schemaVersion: report.schemaVersion, producer: report.producer, environment: report.environment,
    ...(report.adapter ? { adapter: { version: report.adapter.version } } : {}),
    ...(report.actionPermissions ? { actionPermissions: report.actionPermissions } : {}),
    actions,
    omitted: { capabilitiesV1: "tool-output-budget", fullReportSurfaces: ["sdk", "plugin", "cli"] },
  };
}
