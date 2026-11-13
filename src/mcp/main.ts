#!/usr/bin/env node
import { readStartupConfig, startupArguments } from './config.js';
import { createBrokerProvider } from './broker.js';
import { serveDesktopStdio } from './server.js';

let cleanup: (() => Promise<void>) | undefined;
try {
  const args = startupArguments(process.argv.slice(2));
  const options = await readStartupConfig(args.get('--config')!);
  cleanup = () => options.close();
  const broker = args.has('--approval-socket') ? await createBrokerProvider({ socketPath: args.get('--approval-socket')!, secretFd: Number(args.get('--approval-secret-fd')) }) : undefined;
  const handle = serveDesktopStdio({ ...options, approvalProvider: broker?.provider }, { diagnostic: () => { process.stderr.write('MCP transport error; diagnostics withheld.\n'); void cleanup?.(); } });
  let closing = false;
  cleanup = async () => { if (closing) return; closing = true; await handle.close(); broker?.close(); await options.close(); process.stdin.destroy(); };
  process.stdin.once('end', () => { void cleanup?.(); });
  process.once('SIGTERM', () => { void cleanup?.(); }); process.once('SIGINT', () => { void cleanup?.(); });
} catch {
  await cleanup?.();
  process.stderr.write('Desktop MCP startup unavailable; check trusted configuration, private audit state and inherited approval descriptor.\n');
  process.exitCode = 1;
}
