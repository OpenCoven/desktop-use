// Deterministic local model endpoints for real-harness qualification. The scripted model lists nothing, decides
// from the conversation alone and records only derived facts: tool names, schema keys, result shape and image
// hashes. It never records headers, credentials, prompts or image bytes.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const CALL_IDS = Object.freeze({ search: 'qual_search', health: 'qual_health', screenshot: 'qual_screenshot' });
const SERVER = /coven[-_]desktop[-_]use/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Flatten a request's tool list: Codex groups MCP tools in `namespace` tools.
export function desktopTools(tools, protocol) {
  const flat = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) for (const inner of tool.tools) flat.push({ name: inner?.name, namespace: tool.name, schema: inner?.parameters ?? inner?.input_schema });
    else flat.push({ name: tool?.name, type: tool?.type, schema: protocol === 'anthropic-messages' ? tool?.input_schema : tool?.parameters });
  }
  const desktop = flat.filter(tool => typeof tool.name === 'string' && (SERVER.test(tool.name) || SERVER.test(tool.namespace ?? '') || /(^|[_-])computer_use$/.test(tool.name)));
  return {
    desktop: desktop.map(tool => ({
      listedAs: tool.namespace ? `${tool.namespace}/${tool.name}` : tool.name,
      mcpName: tool.namespace ? tool.name : tool.name.replace(/^.*coven[-_]desktop[-_]use(__|[_\-/.])?/, '') || tool.name,
      callName: tool.name, namespace: tool.namespace,
      schemaTopLevelKeys: tool.schema && typeof tool.schema === 'object' ? Object.keys(tool.schema) : null,
    })),
    otherToolCount: flat.length - desktop.length,
    otherTools: flat.filter(tool => !desktop.includes(tool)).map(tool => String(tool.namespace ? `${tool.namespace}/${tool.name}` : tool.name ?? tool.type ?? '?').replace(/[^\w:/.-]/g, '').slice(0, 64)).slice(0, 60),
  };
}

const parseJson = text => { try { return JSON.parse(text); } catch { return undefined; } };
function dataUrl(url) {
  const match = typeof url === 'string' && /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], bytes: Buffer.from(match[2], 'base64') } : undefined;
}

// The first complete JSON object in a text, and whether it is the whole text. Harnesses may add their own lines
// before it (Codex: "Wall time: ...\nOutput:\n") or after it (Copilot: an omitted-image notice).
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      const value = parseJson(text.slice(start, i + 1));
      return value === undefined ? undefined : { value, whole: !text.slice(0, start).trim() && !text.slice(i + 1).trim() };
    }
  }
  return undefined;
}

// Classify one model-visible tool result: structured content and image handling.
export function classifyResult({ texts, images, action, fixtureSha256, shape = null }) {
  let structured, carrier = null;
  for (const text of texts) {
    const extracted = extractJsonObject(text);
    const value = extracted?.value;
    const candidates = [value, value?.structuredContent, ...(Array.isArray(value?.content) ? value.content.map(item => parseJson(item?.text ?? '')) : [])];
    structured = candidates.find(item => item && typeof item === 'object' && typeof item.status === 'string' && item.action === action);
    if (structured) { carrier = extracted.whole ? 'text-json' : 'text-json-with-harness-text'; break; }
  }
  const joined = texts.join('\n');
  const status = structured?.status ?? /"status":\s*"([a-zA-Z]+)"/.exec(joined)?.[1] ?? null;
  const result = {
    resultSeen: true, status, resultShape: shape, textChars: texts.reduce((sum, text) => sum + text.length, 0),
    structuredContent: structured ? 'delivered' : joined.length ? 'transformed' : 'dropped',
    ...(structured ? {} : { transformation: /output too large|saved to:|truncated/i.test(joined) ? 'harness-truncated-or-spilled' : joined.length ? 'not-parseable' : null }),
    structuredKeys: structured ? Object.keys(structured).sort() : null,
    structuredCarrier: structured ? carrier : null,
  };
  if (action === 'screenshot') {
    const exact = images.find(image => image.mediaType === 'image/png' && sha256(image.bytes) === fixtureSha256);
    result.image = {
      handling: exact ? 'delivered' : images.length ? 'transformed' : 'dropped',
      count: images.length,
      mediaTypes: [...new Set(images.map(image => image.mediaType))],
      byteLengths: images.map(image => image.bytes.length),
      fixtureBytesMatch: Boolean(exact),
      carrier: images[0]?.carrier ?? null,
      textPlaceholder: !images.length && /\[(image|screenshot)[^\]]*\]|image[^.\n]{0,60}(omitted|dropped|removed|unavailable|not supported)/i.test(joined),
    };
  }
  return result;
}

function anthropicResults(messages) {
  const calls = new Set(), results = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') calls.add(block.id);
      if (block?.type === 'tool_result') {
        const parts = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : Array.isArray(block.content) ? block.content : [];
        results.set(block.tool_use_id, {
          shape: typeof block.content === 'string' ? ['string'] : parts.map(part => part?.type ?? typeof part),
          texts: parts.filter(part => part?.type === 'text').map(part => String(part.text ?? '')),
          images: parts.filter(part => part?.type === 'image' && part.source?.type === 'base64').map(part => ({ mediaType: part.source.media_type, bytes: Buffer.from(String(part.source.data ?? ''), 'base64'), carrier: 'tool-result' })),
        });
      }
    }
  }
  return { calls, results };
}

function responsesResults(input) {
  const calls = new Set(), results = new Map();
  const items = Array.isArray(input) ? input : [];
  items.forEach((item, index) => {
    if (item?.type === 'function_call') calls.add(item.call_id);
    if (item?.type !== 'function_call_output') return;
    const parts = typeof item.output === 'string' ? [{ type: 'input_text', text: item.output }] : Array.isArray(item.output) ? item.output : [];
    const images = parts.filter(part => part?.type === 'input_image').map(part => ({ ...dataUrl(part.image_url), carrier: 'tool-result' })).filter(image => image.bytes);
    // Some harnesses deliver tool images in a follow-up user message instead of the tool output.
    const next = items[index + 1];
    if (!images.length && next?.type === 'message' && next.role === 'user' && Array.isArray(next.content)) {
      for (const part of next.content) if (part?.type === 'input_image') { const image = dataUrl(part.image_url); if (image) images.push({ ...image, carrier: 'follow-up-message' }); }
    }
    results.set(item.call_id, { shape: typeof item.output === 'string' ? ['string'] : parts.map(part => part?.type ?? typeof part), texts: parts.filter(part => typeof part?.text === 'string').map(part => part.text), images });
  });
  return { calls, results };
}

export function createModelEndpoint({ protocol, fixtureSha256, reason }) {
  if (!['anthropic-messages', 'openai-responses'].includes(protocol)) throw new TypeError(`Unknown endpoint protocol ${protocol}`);
  const state = { requests: 0, toolRequests: 0, discovery: null, laterListings: new Set(), observation: { health: { called: false, resultSeen: false }, screenshot: { called: false, resultSeen: false } }, finished: false, unexpectedPaths: new Set(), models: new Set() };
  const callId = action => protocol === 'anthropic-messages' ? `toolu_${CALL_IDS[action]}` : `call_${CALL_IDS[action]}`;
  const inputs = { health: { action: 'health', reason }, screenshot: { action: 'screenshot', mode: 'screen', format: 'png', reason } };

  function plan(body) {
    const listing = desktopTools(body.tools, protocol);
    if (Array.isArray(body.tools) && body.tools.length) {
      state.toolRequests++;
      if (!state.discovery) state.discovery = { endpointReached: true, mode: 'listed', desktopTools: listing.desktop, otherToolCount: listing.otherToolCount, otherTools: listing.otherTools };
      else for (const tool of listing.desktop) state.laterListings.add(tool.listedAs);
    }
    // Deferred discovery (Codex `tool_search`): MCP tools arrive in a tool_search_output, not the request's tool list.
    const items = protocol === 'openai-responses' && Array.isArray(body.input) ? body.input : [];
    const searched = items.find(item => item?.type === 'tool_search_output' && item.call_id === callId('search'));
    const found = searched ? desktopTools(searched.tools, protocol) : null;
    if (found && state.discovery && state.discovery.mode === 'listed' && !state.discovery.desktopTools.length) {
      state.discovery = { ...state.discovery, mode: 'tool-search', desktopTools: found.desktop };
    }
    if (searched && state.discovery && !state.discovery.search) state.discovery.search = { status: typeof searched.status === 'string' ? searched.status : null, returnedTools: (Array.isArray(searched.tools) ? searched.tools : []).map(tool => tool?.type === 'namespace' ? `${tool.name}[${(tool.tools ?? []).map(inner => inner?.name).join(',')}]` : String(tool?.name ?? tool?.type)).map(name => name.replace(/[^\w:/.,[\]-]/g, '').slice(0, 120)).slice(0, 20) };
    const search = (body.tools ?? []).find(item => item?.type === 'tool_search');
    if (!listing.desktop.length && !found && search && !items.some(item => item?.type === 'tool_search_call')) return { kind: 'search' };
    const tool = [...listing.desktop, ...(found?.desktop ?? [])].find(item => item.mcpName === 'computer_use');
    if (!tool) return { kind: 'text', text: listing.desktop.length || !body.tools?.length ? 'QUALIFICATION: no action.' : 'QUALIFICATION: computer_use is not listed.' };
    const { calls, results } = protocol === 'anthropic-messages' ? anthropicResults(body.messages) : responsesResults(body.input);
    for (const action of ['health', 'screenshot']) {
      const seen = results.get(callId(action));
      if (seen && !state.observation[action].resultSeen) state.observation[action] = { called: true, ...classifyResult({ ...seen, action, fixtureSha256 }) };
    }
    for (const action of ['health', 'screenshot']) {
      if (!calls.has(callId(action))) { state.observation[action].called = true; return { kind: 'tool', action, tool }; }
      if (!results.has(callId(action))) return { kind: 'text', text: `QUALIFICATION: ${action} result missing.` };
    }
    state.finished = true;
    return { kind: 'text', text: 'QUALIFICATION: complete.' };
  }

  function anthropic(req, res, body) {
    const decision = plan(body);
    const model = typeof body.model === 'string' ? body.model : 'qualification';
    const block = decision.kind === 'tool' ? { type: 'tool_use', id: callId(decision.action), name: decision.tool.callName, input: inputs[decision.action] } : { type: 'text', text: decision.text };
    const stop = decision.kind === 'tool' ? 'tool_use' : 'end_turn';
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: `msg_qual_${state.requests}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { id: `msg_qual_${state.requests}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (block.type === 'tool_use') {
      event('content_block_start', { index: 0, content_block: { ...block, input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
    }
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {});
    res.end();
  }

  function responses(req, res, body) {
    const decision = plan(body);
    const item = decision.kind === 'search'
      ? { type: 'tool_search_call', id: `tsc_${CALL_IDS.search}`, call_id: callId('search'), execution: 'client', arguments: { query: 'computer_use desktop', limit: 8 }, status: 'completed' }
      : decision.kind === 'tool'
      ? { type: 'function_call', id: `fc_${CALL_IDS[decision.action]}`, call_id: callId(decision.action), name: decision.tool.callName, ...(decision.tool.namespace ? { namespace: decision.tool.namespace } : {}), arguments: JSON.stringify(inputs[decision.action]), status: 'completed' }
      : { type: 'message', id: `msg_qual_${state.requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: decision.text, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const response = { id: `resp_qual_${state.requests}`, object: 'response', status: 'completed', model: body.model ?? 'qualification', output: [item] };
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { ...response, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } });
    res.end();
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      const body = parseJson(raw || '{}') ?? {};
      if (protocol === 'anthropic-messages' && req.method === 'POST' && path.endsWith('/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
      const ours = req.method === 'POST' && (protocol === 'anthropic-messages' ? path.endsWith('/v1/messages') : path.endsWith('/responses'));
      if (!ours) { state.unexpectedPaths.add(`${req.method} ${path.replace(/[^a-zA-Z0-9/_.-]/g, '')}`.slice(0, 80)); res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
      state.requests++;
      // The model slug the harness requests: harness budgets can depend on its model metadata (#52).
      if (typeof body.model === 'string') state.models.add(body.model.replace(/[^a-zA-Z0-9._:/-]/g, '').slice(0, 80));
      try { return protocol === 'anthropic-messages' ? anthropic(req, res, body) : responses(req, res, body); }
      catch { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{}'); }
    });
  });

  return {
    protocol,
    async start() { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { port: server.address().port }; },
    async stop() { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
    observations() {
      return {
        requests: state.requests, toolRequests: state.toolRequests,
        discovery: state.discovery ?? { endpointReached: state.requests > 0, desktopTools: [], otherToolCount: 0, otherTools: [] },
        laterListings: [...state.laterListings], observation: state.observation, finished: state.finished,
        unexpectedPaths: [...state.unexpectedPaths].slice(0, 20),
        requestedModels: [...state.models].slice(0, 5),
      };
    },
  };
}
