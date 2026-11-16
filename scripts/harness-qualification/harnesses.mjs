// Launch recipes for real harness binaries. Every recipe writes only inside the run's disposable home and points the
// harness at the run's deterministic local endpoint. No recipe reads the operator's own harness configuration.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SERVER_NAME = 'coven-desktop-use';
// Synthetic local credential: the deterministic endpoint ignores it and no provider ever receives it.
const LOCAL_KEY = 'qualification-local-endpoint-only-not-a-credential';
const writePrivate = (path, text) => writeFile(path, text, { mode: 0o600 });
const toml = value => JSON.stringify(value);

const claudeCode = {
  id: 'claude-code', label: 'Claude Code', binary: 'claude', protocol: 'anthropic-messages', variants: ['default'],
  recipe: { mode: 'print (-p) with --bare, --strict-mcp-config and --allowedTools mcp__coven-desktop-use__computer_use', endpoint: 'ANTHROPIC_BASE_URL' },
  async prepare({ root, home, workspace, port, server, prompt }) {
    const config = join(home, '.claude');
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writePrivate(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [LOCAL_KEY.slice(-20)], rejected: [] }, projects: { [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
    const mcp = join(root, 'claude-mcp.json');
    await writePrivate(mcp, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: server.command, args: server.args } } }));
    return {
      env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: LOCAL_KEY, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MCP_CONNECTION_NONBLOCKING: 'false' },
      args: ['--bare', '--mcp-config', mcp, '--strict-mcp-config', '--allowedTools', `mcp__${SERVER_NAME}__computer_use`, '--debug-file', join(root, 'harness-debug.log'), '--debug', 'mcp', '-p', prompt],
      debugLog: join(root, 'harness-debug.log'),
    };
  },
};

const codex = {
  id: 'codex', label: 'Codex CLI', binary: 'codex', protocol: 'openai-responses', variants: ['default', 'tool-search'],
  recipe: { mode: 'exec --skip-git-repo-check', endpoint: 'model_providers base_url (wire_api = responses)', mcp: 'default_tools_approval_mode = "approve", startup_readiness = "catalog"', features: 'plugins = false (no curated plugin sync from GitHub)' },
  async prepare({ home, port, server, prompt, variant }) {
    const config = join(home, '.codex');
    // An unknown model slug gets every MCP tool listed up front. `tool-search` names a model whose Codex metadata
    // defers MCP tools behind the client-side `tool_search` tool, so discovery goes through a search call.
    const model = variant === 'tool-search' ? 'gpt-5.5' : 'qualification';
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writePrivate(join(config, 'config.toml'), [
      `model = ${toml(model)}`, 'model_provider = "qualification"', 'approval_policy = "never"', '',
      '[model_providers.qualification]', 'name = "qualification"', `base_url = ${toml(`http://127.0.0.1:${port}/v1`)}`, 'wire_api = "responses"', '',
      `[mcp_servers.${SERVER_NAME}]`, `command = ${toml(server.command)}`, `args = [${server.args.map(toml).join(', ')}]`,
      'default_tools_approval_mode = "approve"', 'startup_readiness = "catalog"', '',
      // No curated plugin sync: it clones a marketplace from GitHub and can outlive the harness.
      '[features]', 'plugins = false', '',
    ].join('\n'));
    return { env: { CODEX_HOME: config }, args: ['exec', '--skip-git-repo-check', prompt] };
  },
};

const copilot = {
  id: 'copilot', label: 'GitHub Copilot CLI', binary: 'copilot', protocol: 'anthropic-messages', variants: ['default', 'vision'],
  recipe: { mode: 'prompt (-p) with --additional-mcp-config, --allow-tool coven-desktop-use and --disable-builtin-mcps', endpoint: 'BYOK: COPILOT_PROVIDER_BASE_URL, COPILOT_PROVIDER_TYPE=anthropic, COPILOT_OFFLINE=true' },
  async prepare({ root, home, port, server, prompt, variant }) {
    const config = join(home, '.copilot');
    await mkdir(config, { recursive: true, mode: 0o700 });
    const mcp = join(root, 'copilot-mcp.json');
    await writePrivate(mcp, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'local', command: server.command, args: server.args, tools: ['*'] } } }));
    return {
      env: { COPILOT_HOME: config, COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_TELEMETRY_DISABLED: 'true', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}`, COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_PROVIDER_API_KEY: LOCAL_KEY, COPILOT_MODEL: 'claude-sonnet-4', ...(variant === 'vision' ? { COPILOT_PROVIDER_VISION: 'true' } : {}) },
      args: ['-p', prompt, '--additional-mcp-config', `@${mcp}`, '--allow-tool', SERVER_NAME, '--disable-builtin-mcps', '--no-auto-update'],
    };
  },
};

// Harnesses in the support plan that this runner cannot drive yet. Each records why, so it reports unqualified.
const blocked = (id, label, binary, reason, detail) => ({ id, label, binary, blocked: { reason, detail }, variants: ['default'] });

export const HARNESSES = Object.freeze({
  'claude-code': claudeCode,
  codex,
  copilot,
  opencode: blocked('opencode', 'OpenCode', 'opencode', 'no-runner-recipe', 'No launch recipe yet; needs a verified MCP config shape and a configurable provider base URL (#34).'),
  hermes: blocked('hermes', 'Hermes', 'hermes', 'no-runner-recipe', 'No launch recipe yet; needs a verified MCP config shape and a configurable provider base URL (#34).'),
  'coven-code': blocked('coven-code', 'Coven Code', 'coven-code', 'no-runner-recipe', 'No verified recipe: the MCP server was not started from settings.json or --mcp-config in earlier runs (#34).'),
});
