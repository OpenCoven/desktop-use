import { readFileSync } from 'node:fs';
export { CANONICAL_ACTIONS } from './computer-use-actions.js';
export type { CanonicalAction } from './computer-use-actions.js';
export type { CapabilityReportV1 } from './capabilities.js';
export type { ObservationImage } from './observation.js';
/** Shared v1 schemas, shipped with the package and usable without a host runtime. */
const schema = (name: string): Readonly<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`../contracts/v1/${name}.schema.json`, import.meta.url), 'utf8'));
export const observationSchemaV1 = schema('observation');
export const capabilitiesSchemaV1 = schema('capabilities');
export const canonicalActionsSchemaV1 = schema('canonical-actions');
