#!/usr/bin/env node
import { createDesktopClient } from '../src/core/client.js';
import { readStartupConfig } from '../src/mcp/config.js';
import { terminalPrompt } from './approval-host/terminal.js';

// A small standalone application using the SDK directly, with the same trusted local configuration.
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error();
  const options = await readStartupConfig(process.argv[3]);
  const terminal = terminalPrompt();
  try {
    const client = createDesktopClient({ ...options, approvalProvider: challenge => terminal.prompt(challenge, challenge.signal) });
    const result = await client.execute({ action: 'file-write', path: 'reviewed-example.txt', content: 'A reviewed workspace effect.' }, { callId: 'embedding-example' });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { terminal.close(); await options.close(); }
} catch { process.stderr.write('Embedding example unavailable; check trusted configuration.\n'); process.exitCode = 1; }
