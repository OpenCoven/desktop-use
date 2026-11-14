const reasons = [
  'ARGUMENTS_INVALID', 'RECIPE_INVALID', 'CONFIG_UNAVAILABLE', 'CONFIG_UNSAFE', 'CONFIG_INVALID',
  'ADAPTER_PATH_INVALID', 'STATE_DIRECTORY_UNAVAILABLE', 'AUDIT_UNAVAILABLE',
  'APPROVAL_DESCRIPTOR_UNAVAILABLE', 'STARTUP_UNAVAILABLE',
] as const;
export type StartupReason = typeof reasons[number];

/** Never carry OS exception messages or input values across the CLI diagnostic boundary. */
export class StartupError extends Error {
  constructor(readonly reason: StartupReason) { super(reason); }
}

export function startupDiagnostic(error: unknown): string {
  const reason = error instanceof StartupError && reasons.includes(error.reason) ? error.reason : 'STARTUP_UNAVAILABLE';
  return `Desktop MCP startup unavailable [${reason}].\n`;
}
