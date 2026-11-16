import { discoverCapabilityControls, type CapabilityReportV1 } from "./capabilities.js";

type Report = CapabilityReportV1;
type ReportAction = Report["actions"][keyof Report["actions"]];
type ReportVariant = ReportAction["variants"][number];

/**
 * Report variants of one action that are identical except for their capture mode. Every field is copied from those
 * variants, and `enabled` is the reference consumer's eligibility for them. An absent list means the report's is empty.
 */
export type CapabilitySummaryVariantV1 = Pick<ReportVariant, "state"> & {
  modes?: NonNullable<ReportVariant["mode"]>[];
  formats?: NonNullable<ReportVariant["limits"]["parameters"][string]["values"]>;
  formatKnowledge?: "known" | "unknown";
  selectors?: string[];
  provider: string;
  enabled: boolean;
  reasonCodes?: string[];
};

/**
 * One action of a capability summary: the report's own fields, derived eligibility, and its grouped variants. The
 * policy omits `gatewayPolicy`, which v1 fixes to "not-reported"; an absent list means the report's is empty.
 */
export type CapabilitySummaryActionV1 = Pick<ReportAction, "state" | "surfaces"> & {
  enabled: boolean;
  policy: Omit<ReportAction["policy"], "gatewayPolicy">;
  reasonCodes?: string[];
  variants?: CapabilitySummaryVariantV1[];
};

/**
 * Compact, model-facing projection of a v1 capabilities report (ADR 0002, #52). It keeps every variant's eligibility
 * and its mode, format, selector and provider association; it omits variant limits other than format, constraints
 * and evidence. Hosts that need those read the full report from the SDK, the plugin or the CLI.
 */
export type CapabilitySummaryV1 = Pick<Report, "schemaVersion" | "producer" | "environment"> & {
  adapter?: { version: string | null };
  actionPermissions?: Report["actionPermissions"];
  actions: Record<keyof Report["actions"], CapabilitySummaryActionV1>;
  omitted: { capabilitiesV1: "tool-output-budget"; fullReportSurfaces: ("sdk" | "plugin" | "cli")[] };
};

function summarizeVariants(variants: ReportVariant[], enabled: boolean[]): CapabilitySummaryVariantV1[] {
  const groups: { key: string; variant: CapabilitySummaryVariantV1 }[] = [];
  variants.forEach((variant, index) => {
    const format = variant.limits.parameters.format;
    const fields: Omit<CapabilitySummaryVariantV1, "modes"> = {
      ...(format?.values ? { formats: format.values } : {}), ...(format?.knowledge ? { formatKnowledge: format.knowledge } : {}),
      ...(variant.selectors.length ? { selectors: variant.selectors } : {}), provider: variant.provider.name,
      state: variant.state, enabled: enabled[index] === true, ...(variant.reasonCodes.length ? { reasonCodes: variant.reasonCodes } : {}),
    };
    // A mode-less variant never merges with a moded one, so the expansion reproduces each report variant exactly.
    const key = JSON.stringify([variant.mode === null, fields]);
    const group = groups.find(candidate => candidate.key === key);
    if (!group) groups.push({ key, variant: variant.mode === null ? fields : { modes: [variant.mode], ...fields } });
    else if (variant.mode !== null && !group.variant.modes!.includes(variant.mode)) group.variant.modes!.push(variant.mode);
  });
  return groups.map(group => group.variant);
}

export function summarizeCapabilities(report: Report): CapabilitySummaryV1 {
  // The reference consumer validates the report and owns the eligibility rule; its variants keep the report's order.
  const controls = new Map(discoverCapabilityControls(report).map(control => [control.action, control]));
  const actions = Object.fromEntries(Object.entries(report.actions).map(([name, action]) => {
    const control = controls.get(name as keyof Report["actions"])!;
    const variants = summarizeVariants(action.variants, control.variants.map(variant => variant.enabled));
    return [name, {
      state: action.state, enabled: control.enabled, surfaces: action.surfaces, policy: { profile: action.policy.profile, approval: action.policy.approval },
      ...(action.reasonCodes.length ? { reasonCodes: action.reasonCodes } : {}), ...(variants.length ? { variants } : {}),
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
