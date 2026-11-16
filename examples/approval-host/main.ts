#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, chmod } from 'node:fs/promises';
import { startApprovalHost } from './broker.js';
import { terminalPrompt } from './terminal.js';
import { spawnConnector } from './connector.js';

let cleanup: (() => Promise<void>) | undefined;
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error();
  // The reference host owns the ephemeral secret and creates the private IPC endpoint.
  const directory = await realpath(await mkdtemp('/tmp/cdu-')); await chmod(directory, 0o700);
  const secret = randomBytes(32); const terminal = terminalPrompt();
  cleanup = async () => { terminal.close(); secret.fill(0); await rm(directory, { force: true, recursive: true }); };
  const host = await startApprovalHost({ directory, secret, prompt: terminal.prompt });
  const child = spawnConnector({ config: process.argv[3], approvalSocket: host.socketPath, secret, stdout: 'inherit' });
  let closing = false;
  cleanup = async () => { if (closing) return; closing = true; await host.close(); terminal.close(); secret.fill(0); await rm(directory, { force: true, recursive: true }); };
  process.stdin.pipe(child.stdin!);
  process.once('SIGTERM', () => child.kill('SIGTERM')); process.once('SIGINT', () => child.kill('SIGINT'));
  const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('exit', value => resolve(value ?? 1)); });
  process.stdin.unpipe(child.stdin!); process.stdin.pause(); await cleanup(); process.exitCode = code;
} catch {
  await cleanup?.(); process.stderr.write('Approval reference host unavailable; diagnostics withheld.\n'); process.exitCode = 1;
}
