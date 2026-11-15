import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The one code path that hands a connector its broker secret: through inherited descriptor 3, never
 * arguments, environment, files or logs. Both reference hosts (stdio host and approver) use it.
 */
export function spawnConnector(options: { config: string; approvalSocket: string; secret: Buffer; stdout: 'inherit' | 'pipe'; sessionSuffix?: string }): ChildProcess {
  const entry = fileURLToPath(new URL('../../src/mcp/main.js', import.meta.url));
  const args = [entry, '--config', options.config, '--approval-socket', options.approvalSocket, '--approval-secret-fd', '3'];
  if (options.sessionSuffix !== undefined) args.push('--session-suffix', options.sessionSuffix);
  const child = spawn(process.execPath, args, { stdio: ['pipe', options.stdout, 'inherit', 'pipe'] });
  child.stdio[3]!.on('error', () => {});
  (child.stdio[3] as import('node:stream').Writable).end(options.secret.toString('hex') + '\n');
  child.stdin!.on('error', () => {});
  return child;
}
