import { CANONICAL_ACTIONS, LEGACY_ACTION_ALIASES, normalizeComputerUseAction, type LegacyAction } from "./computer-use-actions.js";
import { PLUGIN_NUMBER_LIMITS } from "./plugin-request-limits.js";
const LEGACY_ACTIONS = Object.keys(LEGACY_ACTION_ALIASES) as LegacyAction[];

export const ComputerUseToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [...CANONICAL_ACTIONS, ...LEGACY_ACTIONS],
      // Singleton branches survive the pinned host's provider schema conversion;
      // grouped enum branches can become an unbounded string schema on Gemini.
      anyOf: [
        ...CANONICAL_ACTIONS.map(action => ({ type: "string", const: action })),
        ...LEGACY_ACTIONS.map(action => ({
          type: "string", const: action, deprecated: true,
          description: `Deprecated; use ${normalizeComputerUseAction(action)} instead. Removal targeted at 0.2.0.`,
        })),
      ],
      description: "Computer-use action to perform. Prefer the 18 canonical actions. Five deprecated aliases remain accepted and visible to hosts during this compatibility release: permissions -> doctor, see -> inspect, capture -> screenshot, type -> type-text, press -> keypress. Removal targeted at 0.2.0.",
    },
    app: { type: "string", description: "Target app name, bundle id, or PID:123." },
    windowTitle: { type: "string", description: "Partial target window title." },
    windowId: { type: "number", ...PLUGIN_NUMBER_LIMITS.windowId, description: "Platform window id." },
    screenIndex: { type: "number", ...PLUGIN_NUMBER_LIMITS.screenIndex },
    mode: { type: "string", enum: ["screen", "window", "frontmost", "auto"] },
    path: { type: "string", description: "Target file path or output image path." },
    format: { type: "string", enum: ["png", "jpg"] },
    annotate: {
      type: "boolean",
      description: "Annotate UI elements for inspect. Default true.",
    },
    retina: {
      type: "boolean",
      description: "Capture at Retina resolution when supported.",
    },
    analyze: { type: "string", description: "Optional backend analysis prompt." },
    on: { type: "string", description: "Element id from inspect, e.g. B1." },
    query: { type: "string", description: "Element text/query for click fallback." },
    coords: { type: "string", description: "Coordinate fallback in x,y form." },
    double: { type: "boolean" },
    right: { type: "boolean" },
    text: { type: "string", description: "Text for type-text. For clipboard-write, text is deprecated; use clipboardText. Removal targeted at 0.2.0." },
    clear: { type: "boolean" },
    pressReturn: { type: "boolean" },
    keys: { type: "array", items: { type: "string" }, description: "Keys for keypress." },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "number", ...PLUGIN_NUMBER_LIMITS.amount },
    command: { type: "string", description: "Executable for shell action. No shell interpolation." },
    args: { type: "array", items: { type: "string" }, description: "Shell argv." },
    cwd: { type: "string", description: "Shell cwd. Defaults to the agent workspace." },
    content: { type: "string", description: "Content for file-write." },
    url: { type: "string", description: "URL for browser-open." },
    clipboardText: { type: "string", description: "Text for clipboard-write." },
    includeText: { type: "boolean", description: "Return approved clipboard/file text when needed." },
    overwrite: { type: "boolean", description: "Allow file-write to replace an existing file." },
    reason: { type: "string", description: "Operator-facing reason for the action." },
    confirm: {
      type: "boolean",
      description:
        "Deprecated compatibility field; it never authorizes execution.",
    },
    timeoutMs: { type: "number", ...PLUGIN_NUMBER_LIMITS.timeoutMs },
  },
} as const;

