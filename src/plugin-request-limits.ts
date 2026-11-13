// These bounds are enforced by normalizeParams and described by plugin discovery.
// UTF-8 byte limits intentionally differ from JSON Schema character lengths.
export const MAX_TEXT_BYTES = 100_000;
export const MAX_ARG_BYTES = 2_048;
export const MAX_ARRAY_ITEMS = 256;
export const KEY_SEPARATOR = ",";
export const PLUGIN_NUMBER_LIMITS = {
  amount: { minimum: 1, maximum: 50 },
  timeoutMs: { minimum: 1000, maximum: 120000 },
  screenIndex: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  windowId: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
} as const;
export const PLUGIN_COORD_LIMITS = { minimum: -2147483648, maximum: 2147483647, units: "desktop-pixels" } as const;
