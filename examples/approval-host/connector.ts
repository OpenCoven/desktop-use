import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Absolute path of the compiled connector entry that both reference hosts launch. */
export const connectorEntry = fileURLToPath(new URL('../../src/mcp/main.js', import.meta.url));

/**
 * The one code path that hands a connector its broker secret: through inherited descriptor 3, never
 * arguments, environment, files or logs. Both reference hosts (stdio host and approver) use it.
 * `detached` gives the connector its own session, so terminal job control (Ctrl+C, Ctrl+Z) reaches only the host.
 */
export function spawnConnector(options: { config: string; approvalSocket: string; secret: Buffer; stdout: 'inherit' | 'pipe'; sessionSuffix?: string; detached?: boolean }): ChildProcess {
  const args = [connectorEntry, '--config', options.config, '--approval-socket', options.approvalSocket, '--approval-secret-fd', '3'];
  if (options.sessionSuffix !== undefined) args.push('--session-suffix', options.sessionSuffix);
  const child = spawn(process.execPath, args, { stdio: ['pipe', options.stdout, 'inherit', 'pipe'], detached: options.detached ?? false });
  child.stdio[3]!.on('error', () => {});
  (child.stdio[3] as import('node:stream').Writable).end(options.secret.toString('hex') + '\n');
  child.stdin!.on('error', () => {});
  return child;
}
