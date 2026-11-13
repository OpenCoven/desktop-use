import { createHash } from "node:crypto";
import { CANONICAL_ACTIONS, normalizeComputerUseAction, type CanonicalAction } from "./computer-use-actions.js";

const PROFILES = ["full", "observation-only", "desktop-only"] as const;
export type ActionProfile = (typeof PROFILES)[number];
export type ActionPermissions = Readonly<{
  profile: ActionProfile;
  allowedActions: readonly CanonicalAction[];
  snapshotId: string;
}>;
const snapshots = new WeakSet<object>();
const observation = new Set<string>(["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read"]);
const hostFiles = new Set<string>(["shell", "file-list", "file-read", "file-write"]);
export const ACTION_PROFILE_DENIED_REASON = "Action is disabled by the trusted computer-use action permissions.";

export const ACTION_PERMISSIONS_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actionProfile: { type: "string", enum: [...PROFILES], default: "full", description: "Trusted action eligibility preset; changes require plugin/gateway reload. Does not grant approval." },
    allowedActions: { type: "array", uniqueItems: true, items: { type: "string", enum: [...CANONICAL_ACTIONS] }, description: "Optional canonical action intersection with the preset. An empty list retains Stop only; Stop is always available." },
  },
} as const;

function invalid(): never { throw new Error("Invalid action permissions configuration."); }

/** Resolve once at the trusted registration/factory boundary, never from model input. */
export function resolveActionPermissions(config: unknown = {}): ActionPermissions {
  if (!config || typeof config !== "object" || Array.isArray(config)) invalid();
  const proto = Object.getPrototypeOf(config);
  if (proto !== Object.prototype && proto !== null) invalid();
  const values: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(config)) {
    if (key !== "actionProfile" && key !== "allowedActions") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(config, key)!;
    if (!("value" in descriptor)) invalid();
    values[key] = descriptor.value;
  }
  const profile = Object.hasOwn(values, "actionProfile") ? values.actionProfile : "full";
  if (typeof profile !== "string" || !PROFILES.includes(profile as ActionProfile)) invalid();
  let allowed: Set<string> | undefined;
  if (Object.hasOwn(values, "allowedActions")) {
    if (!Array.isArray(values.allowedActions)) invalid();
    allowed = new Set<string>();
    for (const action of values.allowedActions) {
      if (typeof action !== "string" || !CANONICAL_ACTIONS.includes(action as CanonicalAction) || allowed.has(action)) invalid();
      allowed.add(action);
    }
  }
  const allowedActions = Object.freeze(CANONICAL_ACTIONS.filter(action => action === "stop" || (
    (!allowed || allowed.has(action)) &&
    (profile === "full" || (profile === "observation-only" ? observation.has(action) : !hostFiles.has(action)))
  )));
  const snapshot = Object.freeze({ profile: profile as ActionProfile, allowedActions,
    snapshotId: createHash("sha256").update(JSON.stringify([profile, allowedActions])).digest("hex") });
  snapshots.add(snapshot);
  return snapshot;
}

/** A structural lookalike must not bypass validation or smuggle mutable arrays. */
export function validateActionPermissions(permissions: ActionPermissions): ActionPermissions {
  if (!permissions || !snapshots.has(permissions)) throw new Error("Invalid action permissions snapshot; use resolveActionPermissions.");
  return permissions;
}

export function isActionAllowed(permissions: ActionPermissions, action: string): boolean {
  validateActionPermissions(permissions);
  return permissions.allowedActions.includes(normalizeComputerUseAction(action) as CanonicalAction);
}
