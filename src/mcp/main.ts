#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { renderRecipe } from './recipes.js';
import { StartupError, startupDiagnostic } from './startup-error.js';

let cleanup: (() => Promise<void>) | undefined;
try {
  if (process.argv[2] === 'recipe') {
    process.stdout.write(renderRecipe(process.argv.slice(3), { node: process.execPath, entry: fileURLToPath(import.meta.url) }));
  } else if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stderr.write('Usage: coven-desktop-use-mcp --config /absolute/private/config.json [--approval-socket /private/approval.sock --approval-secret-fd 3]\nLocal stdio MCP; stdout is reserved for protocol messages. Node >=22.14.0.\nPrint-only setup: coven-desktop-use-mcp recipe --harness <id> [--config /absolute/config.json] [--workspace /absolute/workspace] [--state /absolute/private/state] [--adapter /absolute/bin/coven-desktop-use]\nHarness ids: claude, codex, copilot, opencode, hermes, coven-code, grok, gemini, cursor, generic. Recipe mode emits JSON to stdout and does not start MCP or create files.\n');
  } else {
    const { readStartupConfig, startupArguments } = await import('./config.js');
    const { createBrokerProvider } = await import('./broker.js');
    const { serveDesktopStdio } = await import('./server.js');
    const args = startupArguments(process.argv.slice(2));
    const options = await readStartupConfig(args.get('--config')!);
    cleanup = () => options.close();
    const broker = args.has('--approval-socket') ? await createBrokerProvider({ socketPath: args.get('--approval-socket')!, secretFd: Number(args.get('--approval-secret-fd')) }).catch(() => { throw new StartupError('APPROVAL_DESCRIPTOR_UNAVAILABLE'); }) : undefined;
    const handle = serveDesktopStdio({ ...options, approvalProvider: broker?.provider }, { diagnostic: () => { process.stderr.write('MCP transport error; diagnostics withheld.\n'); void cleanup?.(); } });
    let closing = false;
    cleanup = async () => { if (closing) return; closing = true; await handle.close(); broker?.close(); await options.close(); process.stdin.destroy(); };
    process.stdin.once('end', () => { void cleanup?.(); });
    process.once('SIGTERM', () => { void cleanup?.(); }); process.once('SIGINT', () => { void cleanup?.(); });
  }
} catch (error) {
  try { await cleanup?.(); } catch { /* Cleanup errors must not reveal private startup data. */ }
  process.stderr.write(startupDiagnostic(error));
  process.exitCode = 1;
}
