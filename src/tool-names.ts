// The only place the plugin's tool names are spelled out in TypeScript.
// openclaw.plugin.json and agents/computer-use/openclaw-agent.json repeat them
// because they are static manifests; src/tool-names.test.ts keeps them in step.

/** Canonical agent tool. New configuration should allow only this name. */
export const COMPUTER_USE_TOOL_NAME = "computer_use";

/** Legacy alias for the same tool, kept so older configuration keeps working. */
export const DESKTOP_USE_TOOL_NAME = "desktop_use";

export const COMPUTER_USE_TOOL_NAMES = [COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME] as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];

export function isComputerUseToolName(name: unknown): name is ComputerUseToolName {
  return (COMPUTER_USE_TOOL_NAMES as readonly unknown[]).includes(name);
}
