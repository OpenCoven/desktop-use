import { isAbsolute } from 'node:path';
import { StartupError } from './startup-error.js';

const SERVER = 'coven-desktop-use';
const DOCS_DATE = '2026-11-14';
type RecipeHarness = {
  id: string; version: string | null; format: 'json' | 'toml' | 'yaml'; target: string;
  sources: string[]; toolName: string; unqualified?: boolean;
};
const harnesses: RecipeHarness[] = [
  { id: 'claude', version: '2.1.325', format: 'json', target: '.mcp.json', sources: ['https://code.claude.com/docs/en/mcp', 'https://code.claude.com/docs/en/agent-sdk/mcp', 'https://github.com/anthropics/claude-code/releases/tag/v2.1.325'], toolName: 'mcp__coven-desktop-use__computer_use' },
  { id: 'codex', version: '0.169.0', format: 'toml', target: '$CODEX_HOME/config.toml', sources: ['https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/config.schema.json', 'https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-mcp/src/tools.rs'], toolName: 'computer_use in namespace coven-desktop-use (mcp__ namespace prefix is feature-dependent)' },
  { id: 'copilot', version: '1.0.107', format: 'json', target: '$COPILOT_HOME/mcp-config.json', sources: ['https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers', 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference', 'https://github.com/github/copilot-cli/releases/tag/v1.0.107'], toolName: 'coven-desktop-use-computer_use' },
  { id: 'opencode', version: '1.19.5', format: 'json', target: 'opencode.json', sources: ['https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/config/mcp.ts', 'https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/mcp/catalog.ts'], toolName: 'coven-desktop-use_computer_use' },
  { id: 'hermes', version: '0.23.1', format: 'yaml', target: '$HERMES_HOME/config.yaml', sources: ['https://github.com/NousResearch/hermes-agent/blob/v0.23.1/website/docs/user-guide/features/mcp.md', 'https://github.com/NousResearch/hermes-agent/blob/v0.23.1/tools/mcp_tool_schema.py'], toolName: 'mcp__coven_desktop_use__computer_use' },
  { id: 'coven-code', version: '0.9.0', format: 'json', target: '$COVEN_CODE_HOME/settings.json (trusted engine-global settings)', sources: ['https://github.com/OpenCoven/coven-code/blob/v0.9.0/docs/configuration.md', 'https://github.com/OpenCoven/coven-code/blob/v0.9.0/src-rust/crates/mcp/src/lib.rs'], toolName: 'coven-desktop-use_computer_use' },
  { id: 'grok', version: null, format: 'toml', target: '$GROK_HOME/config.toml', sources: ['https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md'], toolName: 'coven-desktop-use__computer_use (catalog key; provider may use use_tool)', unqualified: true },
  { id: 'gemini', version: '0.68.0', format: 'json', target: '.gemini/settings.json', sources: ['https://github.com/google-gemini/gemini-cli/blob/v0.68.0/docs/tools/mcp-server.md'], toolName: 'computer_use; harness may qualify colliding names', unqualified: true },
  { id: 'cursor', version: null, format: 'json', target: '.cursor/mcp.json', sources: ['https://cursor.com/docs/mcp'], toolName: 'Harness-selected alias for coven-desktop-use / computer_use; not observed', unqualified: true },
  { id: 'generic', version: null, format: 'json', target: 'Client-specific; mcpServers is an example envelope, not an MCP protocol requirement', sources: ['https://modelcontextprotocol.io/specification/2025-11-25/basic/transports'], toolName: 'computer_use on the MCP wire; model alias is client-specific', unqualified: true },
];

function literalPath(value: string): string {
  // These harnesses expand configuration expressions after parsing JSON/TOML/YAML.
  // Refuse expressions instead of silently pointing a recipe at a different file.
  if (!isAbsolute(value) || /[\u0000-\u001f\u007f]|\$\{|\{(?:env|file):/i.test(value)) throw new StartupError('RECIPE_INVALID');
  return value;
}

/** Pure renderer: never opens config, workspace, state, audit, adapter or approval resources. */
export function renderRecipe(args: string[], runtime: { node: string; entry: string }): string {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--harness', '--config', '--workspace', '--state', '--adapter'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new StartupError('RECIPE_INVALID');
    flags.set(args[i], args[i + 1]);
  }
  const harness = harnesses.find(value => value.id === flags.get('--harness'));
  if (!harness) throw new StartupError('RECIPE_INVALID');
  const config = literalPath(flags.get('--config') ?? '/absolute/private/desktop-use.json');
  const workspaceDir = literalPath(flags.get('--workspace') ?? '/absolute/workspace');
  const stateDir = literalPath(flags.get('--state') ?? '/absolute/private/state');
  const adapterPath = literalPath(flags.get('--adapter') ?? '/absolute/bin/coven-desktop-use');
  const command = literalPath(runtime.node), entry = literalPath(runtime.entry);
  if (!entry.endsWith('.js')) throw new StartupError('RECIPE_INVALID');
  const launch = { command, args: [entry, '--config', config] };
  let snippet: string;
  if (harness.format === 'toml') {
    snippet = `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(launch.args)}\n`;
  } else {
    const value = harness.id === 'opencode' ? { mcp: { servers: { [SERVER]: { type: 'local', command: [command, ...launch.args] } } } }
      : harness.id === 'hermes' ? { mcp_servers: { [SERVER]: launch } }
      : harness.id === 'coven-code' ? { config: { mcp_servers: [{ name: SERVER, type: 'stdio', ...launch }] } }
      : { mcpServers: { [SERVER]: { ...(harness.id === 'copilot' ? { type: 'local', tools: ['computer_use'] } : {}), ...launch } } };
    // JSON is valid YAML too; quote all strings instead of relying on YAML implicit typing.
    snippet = JSON.stringify(value, null, 2) + '\n';
  }
  return JSON.stringify({
    schemaVersion: 1, harness: harness.id, serverName: SERVER, qualification: harness.unqualified ? 'unqualified' : 'recipe-only', nodeRequirement: '>=22.14.0',
    evidence: { version: harness.version, checkedAt: DOCS_DATE, method: harness.version ? 'pinned source/docs check; not real-harness conformance' : 'documentation/protocol only; no harness version qualified', sources: harness.sources, realHarness: false, nativeDesktop: false },
    modelVisibleTool: { wireName: 'computer_use', expected: harness.toolName, observed: false },
    configuration: { format: harness.format, target: harness.target, snippet },
    startupConfig: { path: config, configMode: '0600', stateDirectoryMode: '0700', value: { workspaceDir, stateDir, principalId: 'local-operator', sessionId: 'local-session', adapterPath, actionProfile: 'observation-only' } },
    preparation: [
      'Print-only: nothing was read, created or changed. Replace the absolute placeholders and manually merge the snippet into a disposable harness configuration.',
      'Create the workspace and a separate user-owned canonical private state directory (0700), outside model-writable workspaces; save the connector configuration as a user-owned regular file (0600).',
      'The command selects this installed compiled candidate. Published npm 0.1.3 predates SDK/MCP; published artifact pinning remains part of issue #25.',
      'Harness permissions and auto-approve modes do not authorize desktop effects. Gated operations require the separately configured trusted broker; approval routing remains issue #33.',
      'A recipe is L0 evidence only. Real-harness discovery, aliases, observation, lifecycle and native desktop effects need separate receipts (#35). Windows desktop actions remain unsupported.',
    ],
  }, null, 2) + '\n';
}
