// Every connector-shaped observation-only MCP result fits the smallest measured harness tool-output budget (ADR 0002,
// #52), on both wire revisions and for every shared capability fixture. Discovery carries a faithful summary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolveActionPermissions, type ActionPermissions } from '../action-permissions.js';
import { discoverCapabilityControls } from '../capabilities.js';
import { capabilitySummarySchemaV1 } from '../contracts.js';
import { createDesktopClient } from '../core/client.js';
import { createJsonSchemaValidator } from './schema.js';
import { MCP_RESULT_BUDGET_BYTES } from './result-projection.js';
import { serveDesktopStdio } from './server.js';

const fixtures = new URL('../../contracts/v1/fixtures/', import.meta.url);
const capabilityFixtures = (await readdir(new URL('capabilities/', fixtures))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort();
const png = await readFile(new URL('images/valid.png', fixtures));
const receipt = JSON.parse(await readFile(new URL('observations/valid-png.json', fixtures), 'utf8'));
const validSummary = new Ajv2020({ strict: false }).compile(capabilitySummarySchemaV1);
const bytes = (text: string) => Buffer.byteLength(text);
const unique = <T>(values: T[]) => [...new Set(values)];

// Discovery reads the envelope from `marker`; capture actions write the shared v1 PNG and receipt. No desktop access.
async function fixtureAdapter(root: string) {
  const adapter = join(root, 'adapter.cjs'); const marker = join(root, 'doctor.json');
  await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);let result={ok:true};\nif(args[0]==='doctor'){process.stdout.write(fs.readFileSync(${JSON.stringify(marker)}));process.exit(0);}\nif(args[0]==='screenshot'||args[0]==='inspect'){const path=args[args.indexOf('--path')+1];fs.writeFileSync(path,Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));const receipt=${JSON.stringify(receipt)};receipt.capturedAtMs=Date.now();result={ok:true,path,observationV1:receipt};if(args[0]==='inspect')result.elements=[{id:'B1',role:'button',label:'OK'},{id:'T1',role:'text',label:'Ready'}];}\nconsole.log(JSON.stringify(result));\n`, { mode: 0o700 });
  return {
    adapter,
    async select(name: string) {
      const { report } = JSON.parse(await readFile(new URL(`capabilities/${name === 'schema-unknown' ? 'x11' : name}.json`, fixtures), 'utf8'));
      if (name === 'schema-unknown') report.schemaVersion = 99;
      await writeFile(marker, JSON.stringify({ ok: name !== 'missing-helper', ...(name === 'missing-helper' ? { code: 'ENOENT' } : {}), platform: report.environment.platform, session: report.environment.session, capabilitiesV1: report, ...(name === 'x11-empty' ? { setupGuide: { missingTools: ['scrot', 'xdotool', 'wmctrl'], installCommand: 'sudo apt install scrot xdotool wmctrl' } } : {}) }), { mode: 0o600 });
    },
  };
}

async function connect(t: any, era: 'modern' | 'legacy', options: { workspaceDir: string; adapterPath: string; actionPermissions: ActionPermissions }) {
  const input = new PassThrough(); const output = new PassThrough();
  const server = serveDesktopStdio({ ...options, scope: { principalId: 'budget', sessionId: era }, auditSink: async () => {} }, { input, output });
  const client = new Client({ name: 'result-budget', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(new StdioServerTransport(output, input));
  assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25');
  await client.listTools(); // The client then validates each structuredContent against the advertised outputSchema.
  return async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'computer_use', arguments: args }) as any;
    const text = result.content[0].text as string;
    const structured = JSON.stringify(result.structuredContent);
    const label = `${era} ${JSON.stringify(args)}`;
    assert.ok(bytes(structured) <= MCP_RESULT_BUDGET_BYTES, `${label}: structuredContent is ${bytes(structured)} B, over the ${MCP_RESULT_BUDGET_BYTES} B budget`);
    assert.ok(bytes(text) <= MCP_RESULT_BUDGET_BYTES, `${label}: text is ${bytes(text)} B, over the ${MCP_RESULT_BUDGET_BYTES} B budget`);
    assert.deepEqual(JSON.parse(text), result.structuredContent, `${label}: text and structuredContent differ`);
    return result;
  };
}

// The summary states only what the full report states (the same execution core, on the MCP surface).
function assertFaithfulSummary(mcp: any, core: any, label: string) {
  const { capabilitiesV1: report, agent: _agent, result: rawResult, ...coreRest } = core;
  const { capabilitySummaryV1: summary, result: mcpResult, ...mcpRest } = mcp;
  assert.equal(mcp.capabilitiesV1, undefined, `${label}: MCP carries the full report`);
  assert.equal(mcp.agent, undefined, `${label}: MCP carries the OpenClaw agent profile`);
  assert.equal(JSON.stringify(mcpResult ?? {}).includes('capabilitiesV1'), false, `${label}: MCP carries the raw adapter report`);
  if (rawResult && typeof rawResult === 'object') { const { capabilitiesV1: _raw, ...legacy } = rawResult; assert.deepEqual(mcpResult, JSON.parse(JSON.stringify(legacy)), label); }
  assert.deepEqual(mcpRest, JSON.parse(JSON.stringify(coreRest)), `${label}: the projection changed fields other than the report`);
  if (!report) return assert.equal(summary, undefined, label);
  assert.equal(validSummary(summary), true, `${label}: ${JSON.stringify(validSummary.errors)}`);
  assert.deepEqual([summary.schemaVersion, summary.producer, summary.environment, summary.actionPermissions, summary.adapter?.version], [report.schemaVersion, report.producer, report.environment, report.actionPermissions, report.adapter?.version], label);
  assert.equal(summary.producer.surface, 'mcp');
  const enabled = Object.fromEntries(discoverCapabilityControls(report).map(control => [control.action, control.enabled]));
  assert.deepEqual(Object.keys(summary.actions), Object.keys(report.actions), label);
  for (const [name, action] of Object.entries<any>(report.actions)) {
    const modes = unique(action.variants.map((variant: any) => variant.mode).filter((mode: unknown) => mode !== null));
    const selectors = unique(action.variants.flatMap((variant: any) => variant.selectors));
    assert.deepEqual(summary.actions[name], {
      state: action.state, enabled: enabled[name], surfaces: action.surfaces, policy: action.policy, reasonCodes: action.reasonCodes,
      ...(modes.length ? { modes } : {}), ...(selectors.length ? { selectors } : {}), providers: unique(action.variants.map((variant: any) => variant.provider.name)),
    }, `${label}: ${name}`);
  }
  assert.deepEqual(summary.omitted, { capabilitiesV1: 'tool-output-budget', fullReportSurfaces: ['sdk', 'plugin', 'cli'] });
}

for (const era of ['modern', 'legacy'] as const) {
  test(`${era} MCP results fit the harness tool-output budget for every capability fixture`, { timeout: 120_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-budget-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspaceDir = join(root, 'workspace'); await mkdir(workspaceDir);
    await writeFile(join(workspaceDir, 'notes.txt'), 'small fixture file\n');
    const fixture = await fixtureAdapter(root);
    const observation = resolveActionPermissions({ actionProfile: 'observation-only' });
    const call = await connect(t, era, { workspaceDir, adapterPath: fixture.adapter, actionPermissions: observation });
    const core = createDesktopClient({ workspaceDir, adapterPath: fixture.adapter, actionPermissions: observation, scope: { principalId: 'budget', sessionId: era }, auditSink: async () => {}, surface: 'mcp' });
    const sdk = createDesktopClient({ workspaceDir, adapterPath: fixture.adapter, actionPermissions: observation, scope: { principalId: 'budget-sdk' }, auditSink: async () => {} });
    for (const name of [...capabilityFixtures, 'schema-unknown']) {
      await fixture.select(name);
      for (const action of ['health', 'doctor'] as const) {
        const mcp = await call({ action });
        assertFaithfulSummary(mcp.structuredContent, (await core.execute({ action }, { callId: 'core' })).details, `${era} ${name} ${action}`);
        // The SDK keeps the full report and the raw envelope unchanged.
        const full = (await sdk.execute({ action }, { callId: 'sdk' })).details as any;
        assert.equal(full.capabilitiesV1.producer.surface, 'sdk'); assert.equal(Object.keys(full.capabilitiesV1.actions).length, 18);
        if (action === 'health') assert.equal(full.agent.id, 'computer-use');
      }
    }
    await fixture.select('macos-permission-granted');
    assert.equal((await call({ action: 'stop' })).structuredContent.status, 'success');
    const shot = await call({ action: 'screenshot', mode: 'screen' });
    assert.equal(shot.structuredContent.observationV1.schemaVersion, 1);
    assert.deepEqual(Buffer.from(shot.content.find((block: any) => block.type === 'image').data, 'base64'), png);
    assert.equal((await call({ action: 'inspect' })).structuredContent.success, true);
    assert.equal((await call({ action: 'file-list', path: '.' })).structuredContent.success, true);
    assert.equal((await call({ action: 'file-read', path: 'notes.txt' })).structuredContent.success, true);
    assert.equal((await call({ action: 'click', coords: '1,2' })).structuredContent.code, 'ACTION_PROFILE_DENIED');
    assert.equal((await call({ action: 'file-read', path: 'missing.txt' })).structuredContent.success, false);
  });

  test(`${era} discovery stays within budget when the adapter is missing or doctor is denied`, { timeout: 60_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-budget-edge-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await fixtureAdapter(root); await fixture.select('x11');
    const cases = [
      { label: 'missing adapter', adapterPath: join(root, 'missing-adapter'), actionPermissions: resolveActionPermissions({ actionProfile: 'observation-only' }) },
      { label: 'doctor denied', adapterPath: fixture.adapter, actionPermissions: resolveActionPermissions({ allowedActions: ['health'] }) },
      { label: 'full profile', adapterPath: fixture.adapter, actionPermissions: resolveActionPermissions() },
    ];
    for (const { label, ...options } of cases) {
      const call = await connect(t, era, { workspaceDir: root, ...options });
      const core = createDesktopClient({ workspaceDir: root, ...options, scope: { principalId: 'budget', sessionId: era }, auditSink: async () => {}, surface: 'mcp' });
      for (const action of ['health', 'doctor'] as const) assertFaithfulSummary((await call({ action })).structuredContent, (await core.execute({ action }, { callId: 'core' })).details, `${era} ${label} ${action}`);
      if (label === 'full profile') assert.equal((await call({ action: 'file-write', path: 'unapproved', content: 'x' })).structuredContent.status, 'needsApproval');
    }
  });
}
