import { CANONICAL_ACTIONS, LEGACY_ACTION_ALIASES } from "../src/computer-use-actions.ts";

// Host replay normalizes tool-call ids; use alphanumeric fixture ids.
export const batchCallId = name => `call${name.replace(/[^a-zA-Z0-9]/g, "")}`;
export const callName = (kind, action) => `restricted-${kind}-${action}`;

export function buildRestrictedBatch(profileActions, fixtures) {
  const allowedActions = ["stop", "health", "doctor", "inspect", "screenshot", "file-list", "file-read", "permissions", "see", "capture"].filter(action => profileActions.includes(LEGACY_ACTION_ALIASES[action] ?? action));
  const deniedActions = [...CANONICAL_ACTIONS, ...Object.keys(LEGACY_ACTION_ALIASES)].filter(action => !profileActions.includes(LEGACY_ACTION_ALIASES[action] ?? action));
  const gatedActions = ["click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch", "type", "press"].filter(action => profileActions.includes(LEGACY_ACTION_ALIASES[action] ?? action));
  const calls = [
    ...allowedActions.filter(action => action !== "stop").map(action => ({ name: callName("allowed", action), args: { action, ...fixtures[LEGACY_ACTION_ALIASES[action] ?? action] } })),
    ...deniedActions.map(action => ({ name: callName("denied", action), args: { action, ...fixtures[LEGACY_ACTION_ALIASES[action] ?? action], confirm: true } })),
    ...gatedActions.map(action => ({ name: callName("gated", action), args: { action, ...fixtures[LEGACY_ACTION_ALIASES[action] ?? action], confirm: true } })),
  ];
  return { allowedActions, deniedActions, gatedActions, calls, approvalCalls: gatedActions.map(action => callName("gated", action)) };
}
