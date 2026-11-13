import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { StandardSchemaWithJSON, jsonSchemaValidator } from '@modelcontextprotocol/server';
import { ComputerUseToolSchema } from '../request-schema.js';
import { CANONICAL_ACTIONS } from '../computer-use-actions.js';
import { normalizeParams } from '../core/execution.js';
import type { DesktopRequest } from '../core/client.js';

const ajv = new Ajv2020({ strict: false, allErrors: false });
const { confirm: _confirm, ...properties } = ComputerUseToolSchema.properties;
export const inputSchema = { ...ComputerUseToolSchema, properties: { ...properties, action: { type: 'string', enum: [...CANONICAL_ACTIONS] }, text: { type: 'string', description: 'Text for type-text.' } } };
const contract = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/v1/${name}.schema.json`, import.meta.url), 'utf8'));
const capabilities = contract('capabilities'); const observation = contract('observation');

export const outputSchema = { type: 'object', required: ['status'], properties: { status: { type: 'string' }, success: { type: 'boolean' }, capabilitiesV1: capabilities, observationV1: observation }, additionalProperties: true };
// Standard Schema lets the official SDK use the exact shared JSON contracts, with fixed diagnostics.
function compiled<T>(schema: Record<string, unknown>, extra?: (value: unknown) => void): StandardSchemaWithJSON<T> {
  const validate = ajv.compile(schema);
  return { '~standard': { version: 1, vendor: 'opencoven', jsonSchema: { input: () => schema, output: () => schema }, validate(value) {
    try {
      if (!validate(value)) throw new Error();
      extra?.(value);
      return { value: value as T };
    } catch { return { issues: [{ message: 'Desktop contract validation failed.' }] }; }
  } } };
}
export const requestContract = compiled<DesktopRequest>(inputSchema, value => {
  const params = normalizeParams(value);
  if (params.action === 'clipboard-write' && params.text !== undefined) throw new Error();
});
// Inline shared schemas for clients which do not have our schema registry.
export const resultContract = compiled<Record<string, unknown>>(outputSchema);

/** Public SDK injection seam: never instantiate its older bundled default AJV provider. */
export function createJsonSchemaValidator(): jsonSchemaValidator {
  const cache = new WeakMap<object, ReturnType<Ajv2020['compile']>>();
  return { getValidator<T>(schema: object) {
    let validate = cache.get(schema);
    if (!validate) {
      try { validate = new Ajv2020({ strict: false, allErrors: false }).compile(schema); }
      catch { throw new Error('Desktop contract compilation failed.'); }
      cache.set(schema, validate);
    }
    return (input: unknown) => validate(input)
      ? { valid: true as const, data: input as T, errorMessage: undefined }
      : { valid: false as const, data: undefined, errorMessage: 'Desktop contract validation failed.' };
  } };
}
