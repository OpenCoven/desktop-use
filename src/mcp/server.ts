import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { createDesktopClient, type DesktopClientOptions, type DesktopResult } from '../core/client.js';
import { COMPUTER_USE_TOOL_NAME } from '../tool-names.js';
import { requestContract, resultContract, createJsonSchemaValidator } from './schema.js';

export function serveDesktopStdio(options: DesktopClientOptions, streams: { input?: Readable; output?: Writable; diagnostic?: () => void } = {}) {
  const client = createDesktopClient({ ...options, surface: 'mcp' });
  const pending = new Set<Promise<DesktopResult>>();
  const handle = serveStdio(() => {
    const server = new McpServer({ name: 'coven-desktop-use', version: '0.1.2' }, { jsonSchemaValidator: createJsonSchemaValidator() });
    server.registerTool(COMPUTER_USE_TOOL_NAME, { description: 'Desktop observation and explicitly approved actions. Approval decisions belong to the separate trusted host.', inputSchema: requestContract, outputSchema: resultContract }, async (request, ctx) => {
      const operation = client.execute(request, { callId: String(ctx.mcpReq.id), signal: ctx.mcpReq.signal });
      pending.add(operation);
      try {
        const result = await operation;
        return { content: result.content, structuredContent: result.details, isError: result.details.success === false };
      } catch {
        return { content: [{ type: 'text' as const, text: 'Desktop request failed.' }], structuredContent: { status: 'error', success: false, code: 'DESKTOP_REQUEST_FAILED' }, isError: true };
      } finally { pending.delete(operation); }
    });
    return server;
  }, { legacy: 'serve', transport: new StdioServerTransport(streams.input, streams.output, { maxBufferSize: 2 * 1024 * 1024 }), onerror: () => streams.diagnostic?.() });
  let closing: Promise<void> | undefined;
  return { close() {
    return closing ??= (async () => {
      await handle.close();
      // Cancellation may finish a subprocess asynchronously; retain the audit sink until it settles.
      await Promise.allSettled([...pending]);
    })();
  } };
}
