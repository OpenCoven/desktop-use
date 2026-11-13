/** Canonical order is shared by permission snapshots and model schemas. */
export const CANONICAL_ACTIONS = Object.freeze([
  "health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus",
  "shell", "file-list", "file-read", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch",
] as const);
export type CanonicalAction = (typeof CANONICAL_ACTIONS)[number];
export const LEGACY_ACTION_ALIASES = Object.freeze({
  permissions: "doctor", see: "inspect", capture: "screenshot", type: "type-text", press: "keypress",
} as const satisfies Record<string, CanonicalAction>);
export type LegacyAction = keyof typeof LEGACY_ACTION_ALIASES;

export function normalizeComputerUseAction(action: string): string {
  return Object.hasOwn(LEGACY_ACTION_ALIASES, action)
    ? LEGACY_ACTION_ALIASES[action as LegacyAction] : action;
}
