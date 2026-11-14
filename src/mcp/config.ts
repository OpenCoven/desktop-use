import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveActionPermissions } from '../action-permissions.js';
import type { DesktopClientOptions } from '../core/client.js';
import { privateDirectory } from './broker-protocol.js';
import { StartupError } from './startup-error.js';

export async function readStartupConfig(path: string): Promise<DesktopClientOptions & { close(): Promise<void> }> {
  if (!isAbsolute(path)) throw new StartupError('CONFIG_INVALID');
  const configFile = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => { throw new StartupError('CONFIG_UNAVAILABLE'); });
  let config: any;
  try {
    const stat = await configFile.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new StartupError('CONFIG_UNSAFE');
    try { config = JSON.parse(await configFile.readFile('utf8')); } catch { throw new StartupError('CONFIG_INVALID'); }
  } finally { await configFile.close(); }
  const keys = ['workspaceDir', 'stateDir', 'principalId', 'sessionId', 'adapterPath', 'actionProfile', 'approvalTimeoutMs'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !keys.includes(key))) throw new StartupError('CONFIG_INVALID');
  if (typeof config.workspaceDir !== 'string' || !isAbsolute(config.workspaceDir) || typeof config.stateDir !== 'string' || typeof config.principalId !== 'string' || !config.principalId || (config.sessionId !== undefined && typeof config.sessionId !== 'string')) throw new StartupError('CONFIG_INVALID');
  if (typeof config.adapterPath !== 'string' || !isAbsolute(config.adapterPath)) throw new StartupError('ADAPTER_PATH_INVALID');
  if (config.actionProfile !== undefined && !['full', 'observation-only'].includes(config.actionProfile)) throw new StartupError('CONFIG_INVALID');
  try { await privateDirectory(config.stateDir); } catch { throw new StartupError('STATE_DIRECTORY_UNAVAILABLE'); }
  const audit = await open(join(config.stateDir, 'audit.jsonl'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600).catch(() => { throw new StartupError('AUDIT_UNAVAILABLE'); });
  try {
    const stat = await audit.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new StartupError('AUDIT_UNAVAILABLE');
  } catch { await audit.close().catch(() => {}); throw new StartupError('AUDIT_UNAVAILABLE'); }
  return { workspaceDir: config.workspaceDir, scope: { principalId: config.principalId, sessionId: config.sessionId }, adapterPath: config.adapterPath, actionPermissions: resolveActionPermissions({ actionProfile: config.actionProfile ?? 'observation-only' }), approvalTimeoutMs: config.approvalTimeoutMs, auditSink: async event => { await audit.appendFile(JSON.stringify(event) + '\n'); }, close: () => audit.close() };
}
export function startupArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--approval-socket', '--approval-secret-fd'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new StartupError('ARGUMENTS_INVALID');
    values.set(args[i], args[i + 1]);
  }
  if (!values.has('--config') || values.has('--approval-socket') !== values.has('--approval-secret-fd')) throw new StartupError('ARGUMENTS_INVALID');
  return values;
}
