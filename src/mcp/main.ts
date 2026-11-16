#!/usr/bin/env node
import { readStartupConfig, scopeWithSuffix, startupArguments } from './config.js';
import { runAttach } from './attach.js';
import { createBrokerProvider } from './broker.js';
import { serveDesktopStdio } from './server.js';

let cleanup: (() => Promise<void>) | undefined;
const ATTACH_UNAVAILABLE = 'Desktop approver unavailable or session refused; check the approver terminal and the attach socket path.\n';
let attaching = false;
try {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stderr.write('Usage: coven-desktop-use-mcp --config /absolute/private/config.json [--approval-socket /private/approval.sock --approval-secret-fd 3]\n       coven-desktop-use-mcp attach --socket /absolute/private/attach.sock\nLocal stdio MCP; stdout is reserved for protocol messages. Node >=22.14.0.\n');
  } else if (process.argv[2] === 'attach') {
    // Harness command for an operator-launched approver (ADR 0001): a byte relay with no secret or authority.
    attaching = true;
    if (process.argv.length !== 5 || process.argv[3] !== '--socket') throw new Error('STARTUP_INVALID');
    const code = await runAttach(process.argv[4]);
    if (code !== 0) process.stderr.write(ATTACH_UNAVAILABLE);
    process.exitCode = code; process.stdin.destroy();
  } else {
    const args = startupArguments(process.argv.slice(2));
    const options = await readStartupConfig(args.get('--config')!);
    options.scope = scopeWithSuffix(options.scope, args.get('--session-suffix'));
    cleanup = () => options.close();
    const broker = args.has('--approval-socket') ? await createBrokerProvider({ socketPath: args.get('--approval-socket')!, secretFd: Number(args.get('--approval-secret-fd')) }) : undefined;
    const handle = serveDesktopStdio({ ...options, approvalProvider: broker?.provider }, { diagnostic: () => { process.stderr.write('MCP transport error; diagnostics withheld.\n'); void cleanup?.(); } });
    let closing = false;
    cleanup = async () => { if (closing) return; closing = true; await handle.close(); broker?.close(); await options.close(); process.stdin.destroy(); };
    process.stdin.once('end', () => { void cleanup?.(); });
    process.once('SIGTERM', () => { void cleanup?.(); }); process.once('SIGINT', () => { void cleanup?.(); });
  }
} catch {
  await cleanup?.();
  process.stderr.write(attaching ? ATTACH_UNAVAILABLE : 'Desktop MCP startup unavailable; check trusted configuration, private audit state and inherited approval descriptor.\n');
  process.exitCode = 1;
}
