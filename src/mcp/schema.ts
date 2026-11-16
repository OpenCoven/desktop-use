import { Ajv2020 } from 'ajv/dist/2020.js';
import type { StandardSchemaWithJSON, jsonSchemaValidator } from '@modelcontextprotocol/server';
import { desktopRequestSchemaV1, desktopResultDetailsSchemaV1 } from '../contracts.js';
import { normalizeParams } from '../core/execution.js';
import type { DesktopRequest } from '../core/client.js';

const ajv = new Ajv2020({ strict: false, allErrors: false });
// Claude Code drops a tool whose input schema has a top-level allOf, anyOf or oneOf (#41). MCP therefore lists the
// published v1 request schema without its only top-level combinator, the clipboard-write `text` guard, and still
// validates every call against the full v1 schema below, so the guard keeps its meaning at this boundary.
const { allOf: _clipboardTextGuard, ...advertisedRequestSchema } = desktopRequestSchemaV1;
export const inputSchema: Readonly<Record<string, unknown>> = advertisedRequestSchema;
export const outputSchema = desktopResultDetailsSchemaV1;
// Standard Schema lets the official SDK use the exact shared JSON contracts, with fixed diagnostics.
function compiled<T>(validation: Record<string, unknown>, advertised: Record<string, unknown>, extra?: (value: unknown) => void): StandardSchemaWithJSON<T> {
  const validate = ajv.compile(validation);
  return { '~standard': { version: 1, vendor: 'opencoven', jsonSchema: { input: () => advertised, output: () => advertised }, validate(value) {
    try {
      if (!validate(value)) throw new Error();
      extra?.(value);
      return { value: value as T };
    } catch { return { issues: [{ message: 'Desktop contract validation failed.' }] }; }
  } } };
}
export const requestContract = compiled<DesktopRequest>(desktopRequestSchemaV1, inputSchema, value => {
  const params = normalizeParams(value);
  if (params.action === 'clipboard-write' && params.text !== undefined) throw new Error();
});
// Inline shared schemas for clients which do not have our schema registry.
export const resultContract = compiled<Record<string, unknown>>(outputSchema, outputSchema);

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
