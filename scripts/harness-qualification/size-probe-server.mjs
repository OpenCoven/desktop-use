#!/usr/bin/env node
// Size probe for harness tool-output budgets (#52): a minimal MCP stdio server whose `computer_use` result has
// structured content of an exact compact-JSON size. Padding is made of real capability action entries, so harnesses
// that budget in tokens see realistic JSON. content[0].text carries the same JSON, compact or pretty-printed (the
// connector's own form), so a run shows which carrier a harness budgets. It performs no desktop action and reads only
// its --config file.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { sizedResult } from './budget.mjs';

const configPath = process.argv[process.argv.indexOf('--config') + 1];
const { probeBytes, probeText = 'compact' } = JSON.parse(readFileSync(configPath, 'utf8'));
sizedResult('health', probeBytes);

const tool = {
  name: 'computer_use',
  description: 'Size probe for harness tool-output budgets. Returns structured content of a configured size.',
  inputSchema: { type: 'object', properties: { action: { type: 'string' }, reason: { type: 'string' } }, required: ['action'], additionalProperties: true },
};
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'coven-desktop-use-size-probe', version: '1' } } });
  if (request.method === 'ping') return send({ id: request.id, result: {} });
  if (request.method === 'tools/list') return send({ id: request.id, result: { tools: [tool] } });
  if (request.method === 'tools/call') {
    const structured = sizedResult(String(request.params?.arguments?.action ?? 'health'), probeBytes);
    return send({ id: request.id, result: { content: [{ type: 'text', text: probeText === 'pretty' ? JSON.stringify(structured, null, 2) : JSON.stringify(structured) }], structuredContent: structured } });
  }
  send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
});
