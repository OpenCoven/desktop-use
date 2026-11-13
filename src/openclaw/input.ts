import { CANONICAL_ACTIONS, LEGACY_ACTION_ALIASES, type LegacyAction } from "../computer-use-actions.js";
import { normalizeComputerUseAction } from "../computer-use-policy.js";
import { isActionAllowed, type ActionPermissions } from "../action-permissions.js";
import { ComputerUseToolSchema } from "../request-schema.js";
const LEGACY_ACTIONS = Object.keys(LEGACY_ACTION_ALIASES) as LegacyAction[];

export function permissionToolSchema(permissions: ActionPermissions) {
  const aliases = LEGACY_ACTIONS.filter(action => isActionAllowed(permissions, action));
  const vocabulary = [...permissions.allowedActions, ...aliases];
  const full = permissions.allowedActions.length === CANONICAL_ACTIONS.length;
  const description = full ? ComputerUseToolSchema.properties.action.description
    : `${permissions.allowedActions.length === 1 ? "Stop-only: cancels active same-scope work." : `Eligible canonical actions: ${permissions.allowedActions.join(", ")}.`} ${aliases.length ? `Deprecated aliases: ${aliases.map(action => `${action} -> ${LEGACY_ACTION_ALIASES[action]}`).join(", ")}. Removal targeted at 0.2.0.` : ""} Trusted action eligibility does not grant approval.`;
  return { ...ComputerUseToolSchema, properties: { ...ComputerUseToolSchema.properties, action: {
    ...ComputerUseToolSchema.properties.action,
    enum: vocabulary,
    anyOf: ComputerUseToolSchema.properties.action.anyOf.filter(branch => vocabulary.includes(branch.const)),
    description,
  } } };
}

