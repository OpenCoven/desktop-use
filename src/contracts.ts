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

/** The structured details shared by the SDK/plugin result and MCP structuredContent. */
export const desktopResultDetailsSchemaV1 = {
  $schema: dialect, $id: schemaId('result-details'), title: 'DesktopResultDetailsV1',
  type: 'object', required: ['status'], additionalProperties: true,
  properties: {
    status: { type: 'string', enum: ['success', 'blocked', 'needsApproval', 'unsupported', 'error', 'cancelled', 'timeout'] },
    success: { type: 'boolean' }, capabilitiesV1: capabilitiesSchemaV1, observationV1: observationSchemaV1,
  },
};

/** Full SDK/plugin result envelope; MCP maps details to structuredContent without loss. */
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
