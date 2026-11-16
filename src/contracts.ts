import { readFileSync } from 'node:fs';
import { CANONICAL_ACTIONS } from './computer-use-actions.js';
import { ComputerUseToolSchema } from './request-schema.js';
export { CANONICAL_ACTIONS } from './computer-use-actions.js';
export type { CanonicalAction } from './computer-use-actions.js';
export type { CapabilityReportV1 } from './capabilities.js';
export type { ObservationImage } from './observation.js';
export type { DesktopRequestV1, DesktopResultV1 } from './core/client.js';
/** Shared v1 schemas, shipped with the package and usable without a host runtime. */
const schema = (name: string): Readonly<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`../contracts/v1/${name}.schema.json`, import.meta.url), 'utf8'));
export const observationSchemaV1 = schema('observation');
export const capabilitiesSchemaV1 = schema('capabilities');
export const canonicalActionsSchemaV1 = schema('canonical-actions');

const dialect = 'https://json-schema.org/draft/2020-12/schema';
const schemaId = (name: string) => `https://opencoven.org/desktop-use/contracts/v1/${name}.schema.json`;
const { confirm: _confirm, action: _action, text: _text, ...properties } = ComputerUseToolSchema.properties;

/** Canonical public requests. Byte limits and target/approval checks also run at execution. */
export const desktopRequestSchemaV1 = {
  $schema: dialect, $id: schemaId('request'), title: 'DesktopRequestV1',
  type: 'object', additionalProperties: false, required: ['action'],
  properties: { ...properties, action: { type: 'string', enum: [...CANONICAL_ACTIONS] }, text: { type: 'string', description: 'Text for type-text.' } },
  allOf: [{ if: { properties: { action: { const: 'clipboard-write' } }, required: ['action'] }, then: { not: { required: ['text'] } } }],
};

const capabilityDefs = (capabilitiesSchemaV1 as any).$defs;
const capabilityProperties = (capabilitiesSchemaV1 as any).properties;
const capabilityParameter = capabilityDefs.limits.properties.parameters.additionalProperties.properties;
const capabilityPolicy = capabilityDefs.action.properties.policy.properties;
/**
 * Compact discovery summary that MCP health and doctor carry in place of capabilitiesV1 (ADR 0002): a projection of
 * the full report, versioned on its own. The SDK and plugin keep the full report.
 */
export const capabilitySummarySchemaV1 = {
  $schema: dialect, $id: schemaId('capability-summary'), title: 'CapabilitySummaryV1',
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'producer', 'environment', 'actions', 'omitted'],
  properties: {
    schemaVersion: { const: 1 }, producer: capabilityProperties.producer, environment: capabilityProperties.environment,
    adapter: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: ['string', 'null'] } } },
    actionPermissions: capabilityProperties.actionPermissions,
    actions: { type: 'object', additionalProperties: false, required: [...CANONICAL_ACTIONS], properties: Object.fromEntries(CANONICAL_ACTIONS.map(action => [action, { $ref: '#/$defs/action' }])) },
    omitted: {
      type: 'object', additionalProperties: false, required: ['capabilitiesV1', 'fullReportSurfaces'],
      properties: { capabilitiesV1: { const: 'tool-output-budget' }, fullReportSurfaces: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['sdk', 'plugin', 'cli'] } } },
    },
  },
  $defs: {
    surface: capabilityDefs.surface, state: capabilityDefs.state, reasonCodes: capabilityDefs.reasonCodes,
    action: {
      type: 'object', additionalProperties: false, required: ['state', 'enabled', 'surfaces', 'policy'],
      properties: {
        state: { $ref: '#/$defs/state' }, enabled: { type: 'boolean' }, surfaces: capabilityDefs.action.properties.surfaces,
        // v1 fixes gatewayPolicy to "not-reported", so the summary omits it; an absent list means the report's is empty.
        policy: { type: 'object', additionalProperties: false, required: ['profile', 'approval'], properties: { profile: capabilityPolicy.profile, approval: capabilityPolicy.approval } },
        reasonCodes: { ...capabilityDefs.reasonCodes, minItems: 1 }, variants: { type: 'array', minItems: 1, items: { $ref: '#/$defs/variant' } },
      },
    },
    // Report variants identical except for mode; an absent list means the report's list is empty.
    variant: {
      type: 'object', additionalProperties: false, required: ['provider', 'state', 'enabled'],
      properties: {
        modes: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: capabilityDefs.variant.properties.mode.enum.filter((mode: unknown) => mode !== null) } },
        formats: capabilityParameter.values, formatKnowledge: capabilityParameter.knowledge,
        selectors: { type: 'array', minItems: 1, uniqueItems: true, items: capabilityDefs.variant.properties.selectors.items },
        provider: { type: 'string', minLength: 1 }, state: { $ref: '#/$defs/state' }, enabled: { type: 'boolean' },
        reasonCodes: { ...capabilityDefs.reasonCodes, minItems: 1 },
      },
    },
  },
};

/** The structured details shared by the SDK/plugin result and MCP structuredContent. */
export const desktopResultDetailsSchemaV1 = {
  $schema: dialect, $id: schemaId('result-details'), title: 'DesktopResultDetailsV1',
  type: 'object', required: ['status'], additionalProperties: true,
  properties: {
    status: { type: 'string', enum: ['success', 'blocked', 'needsApproval', 'unsupported', 'error', 'cancelled', 'timeout'] },
    success: { type: 'boolean' }, capabilitiesV1: capabilitiesSchemaV1, capabilitySummaryV1: capabilitySummarySchemaV1, observationV1: observationSchemaV1,
  },
};

/**
 * Full SDK/plugin result envelope. MCP maps details to structuredContent, with one projection (ADR 0002): health
 * and doctor carry capabilitySummaryV1 in place of capabilitiesV1 and omit the adapter's duplicate raw report and the
 * OpenClaw agent profile, so every connector-shaped result fits harness tool-output budgets. The MCP text block is the
 * compact JSON of structuredContent; image blocks are preserved.
 */
export const desktopResultSchemaV1 = {
  $schema: dialect, $id: schemaId('result'), title: 'DesktopResultV1',
  type: 'object', required: ['content', 'details'], additionalProperties: true,
  properties: {
    content: {
      type: 'array', minItems: 1,
      prefixItems: [{ type: 'object', required: ['type', 'text'], properties: { type: { const: 'text' }, text: { type: 'string' } }, additionalProperties: false }],
      items: { type: 'object', required: ['type', 'mimeType', 'data'], properties: { type: { const: 'image' }, mimeType: { enum: ['image/png', 'image/jpeg'] }, data: { type: 'string', minLength: 1 } }, additionalProperties: false },
    },
    details: desktopResultDetailsSchemaV1,
  },
};

/** Version selection is by this supported descriptor, never a model authority field. */
export const desktopExecutionContractV1 = Object.freeze({
  version: 1 as const, requestSchema: desktopRequestSchemaV1, resultSchema: desktopResultSchemaV1, resultDetailsSchema: desktopResultDetailsSchemaV1,
});
