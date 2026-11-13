import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveActionPermissions } from '../action-permissions.js';
import type { DesktopClientOptions } from '../core/client.js';
import { privateDirectory } from './broker-protocol.js';

export async function readStartupConfig(path: string): Promise<DesktopClientOptions & { close(): Promise<void> }> {
  if (!isAbsolute(path)) throw new Error('STARTUP_INVALID');
  const configFile = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: any;
  try {
    const stat = await configFile.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('STARTUP_INVALID');
    config = JSON.parse(await configFile.readFile('utf8'));
  } finally { await configFile.close(); }
  const keys = ['workspaceDir', 'stateDir', 'principalId', 'sessionId', 'adapterPath', 'actionProfile', 'approvalTimeoutMs'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !keys.includes(key))) throw new Error('STARTUP_INVALID');
  if (typeof config.workspaceDir !== 'string' || !isAbsolute(config.workspaceDir) || typeof config.stateDir !== 'string' || typeof config.principalId !== 'string' || !config.principalId || (config.sessionId !== undefined && typeof config.sessionId !== 'string') || typeof config.adapterPath !== 'string' || !isAbsolute(config.adapterPath)) throw new Error('STARTUP_INVALID');
  if (config.actionProfile !== undefined && !['full', 'observation-only'].includes(config.actionProfile)) throw new Error('STARTUP_INVALID');
  await privateDirectory(config.stateDir);
  const audit = await open(join(config.stateDir, 'audit.jsonl'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const stat = await audit.stat();
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) { await audit.close(); throw new Error('AUDIT_UNAVAILABLE'); }
  return { workspaceDir: config.workspaceDir, scope: { principalId: config.principalId, sessionId: config.sessionId }, adapterPath: config.adapterPath, actionPermissions: resolveActionPermissions({ actionProfile: config.actionProfile ?? 'observation-only' }), approvalTimeoutMs: config.approvalTimeoutMs, auditSink: async event => { await audit.appendFile(JSON.stringify(event) + '\n'); }, close: () => audit.close() };
}
export function startupArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--approval-socket', '--approval-secret-fd'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('STARTUP_INVALID');
    values.set(args[i], args[i + 1]);
  }
  if (!values.has('--config') || values.has('--approval-socket') !== values.has('--approval-secret-fd')) throw new Error('STARTUP_INVALID');
  return values;
}
