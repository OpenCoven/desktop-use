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
const entrySet = (entries: unknown[]) => [...new Set(entries.map(entry => JSON.stringify(entry)))].sort();

const variantEntry = (variant: any, enabled: boolean) => ({
  mode: variant.mode,
  formats: variant.limits.parameters.format?.values ?? null,
  formatKnowledge: variant.limits.parameters.format?.knowledge ?? null,
  selectors: variant.selectors,
  provider: variant.provider.name,
  state: variant.state,
  enabled,
  reasonCodes: variant.reasonCodes,
});
const expandSummaryVariants = (groups: any[]) => groups.flatMap(group => (group.modes ?? [null]).map((mode: unknown) => ({
  mode,
  formats: group.formats ?? null,
  formatKnowledge: group.formatKnowledge ?? null,
  selectors: group.selectors ?? [],
  provider: group.provider,
  state: group.state,
  enabled: group.enabled,
  reasonCodes: group.reasonCodes ?? [],
})));

async function fixtureAdapter(root: string) {
  const adapter = join(root, 'adapter.cjs');
  const marker = join(root, 'doctor.json');
  await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);let result={ok:true};\nif(args[0]==='doctor'){process.stdout.write(fs.readFileSync(${JSON.stringify(marker)}));process.exit(0);}\nif(args[0]==='screenshot'||args[0]==='inspect'){const path=args[args.indexOf('--path')+1];fs.writeFileSync(path,Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));const receipt=${JSON.stringify(receipt)};receipt.capturedAtMs=Date.now();result={ok:true,path,observationV1:receipt};if(args[0]==='inspect')result.elements=[{id:'B1',role:'button',label:'OK'},{id:'T1',role:'text',label:'Ready'}];}\nconsole.log(JSON.stringify(result));\n`, { mode: 0o700 });
  return {
    adapter,
    async select(name: string) {
      const { report } = JSON.parse(await readFile(new URL(`capabilities/${name === 'schema-unknown' ? 'x11' : name}.json`, fixtures), 'utf8'));
      if (name === 'schema-unknown') report.schemaVersion = 99;
      await writeFile(marker, JSON.stringify({
        ok: name !== 'missing-helper',
        ...(name === 'missing-helper' ? { code: 'ENOENT' } : {}),
        platform: report.environment.platform,
        session: report.environment.session,
        capabilitiesV1: report,
        ...(name === 'x11-empty' ? { setupGuide: { missingTools: ['scrot', 'xdotool', 'wmctrl'], installCommand: 'sudo apt install scrot xdotool wmctrl' } } : {}),
      }), { mode: 0o600 });
    },
  };
}

async function connect(t: any, era: 'modern' | 'legacy', options: { workspaceDir: string; adapterPath: string; actionPermissions: ActionPermissions }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = serveDesktopStdio({ ...options, scope: { principalId: 'budget', sessionId: era }, auditSink: async () => {} }, { input, output });
  const client = new Client({ name: 'result-budget', version: '1' }, {
    jsonSchemaValidator: createJsonSchemaValidator(),
    ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }),
  });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(new StdioServerTransport(output, input));
  assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25');
  await client.listTools();
  return async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'computer_use', arguments: args }) as any;
    const text = result.content[0].text as string;
    const structured = JSON.stringify(result.structuredContent);
    const label = `${era} ${JSON.stringify(args)}`;
    assert.ok(bytes(structured) <= MCP_RESULT_BUDGET_BYTES, `${label}: structuredContent is ${bytes(structured)} B, over ${MCP_RESULT_BUDGET_BYTES} B`);
    assert.ok(bytes(text) <= MCP_RESULT_BUDGET_BYTES, `${label}: text is ${bytes(text)} B, over ${MCP_RESULT_BUDGET_BYTES} B`);
    assert.deepEqual(JSON.parse(text), result.structuredContent, `${label}: text and structuredContent differ`);
    return result;
  };
}

function assertFaithfulSummary(mcp: any, core: any, label: string) {
  const { capabilitiesV1: report, agent: _agent, result: rawResult, ...coreRest } = core;
  const { capabilitySummaryV1: summary, result: mcpResult, ...mcpRest } = mcp;
  assert.equal(mcp.capabilitiesV1, undefined, `${label}: MCP carries the full report`);
  assert.equal(mcp.agent, undefined, `${label}: MCP carries the OpenClaw agent profile`);
  assert.equal(JSON.stringify(mcpResult ?? {}).includes('capabilitiesV1'), false, `${label}: MCP carries the raw adapter report`);
  if (rawResult && typeof rawResult === 'object') {
    const { capabilitiesV1: _raw, ...legacy } = rawResult;
    assert.deepEqual(mcpResult, JSON.parse(JSON.stringify(legacy)), label);
  }
  assert.deepEqual(mcpRest, JSON.parse(JSON.stringify(coreRest)), `${label}: projection changed unrelated fields`);
  if (!report) return assert.equal(summary, undefined, label);
  assert.equal(validSummary(summary), true, `${label}: ${JSON.stringify(validSummary.errors)}`);
  assert.deepEqual([summary.schemaVersion, summary.producer, summary.environment, summary.actionPermissions, summary.adapter?.version],
    [report.schemaVersion, report.producer, report.environment, report.actionPermissions, report.adapter?.version], label);
  assert.equal(summary.producer.surface, 'mcp');
  assert.deepEqual(Object.keys(summary.actions), Object.keys(report.actions), label);
  for (const control of discoverCapabilityControls(report)) {
    const action = report.actions[control.action];
    const summarized = summary.actions[control.action];
    assert.equal(action.policy.gatewayPolicy, 'not-reported');
    assert.deepEqual([summarized.state, summarized.enabled, summarized.surfaces, { ...summarized.policy, gatewayPolicy: 'not-reported' }, summarized.reasonCodes ?? []],
      [action.state, control.enabled, action.surfaces, action.policy, action.reasonCodes], `${label}: ${control.action}`);
    assert.equal(control.variants.length, action.variants.length);
    assert.deepEqual(entrySet(expandSummaryVariants(summarized.variants ?? [])),
      entrySet(action.variants.map((variant: any, index: number) => variantEntry(variant, control.variants[index].enabled))),
      `${label}: ${control.action} variants`);
  }
  assert.deepEqual(summary.omitted, { capabilitiesV1: 'tool-output-budget', fullReportSurfaces: ['sdk', 'plugin', 'cli'] });
}

for (const era of ['modern', 'legacy'] as const) {
  test(`${era} MCP results fit the harness tool-output budget for every capability fixture`, { timeout: 120_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-budget-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir);
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
        const full = (await sdk.execute({ action }, { callId: 'sdk' })).details as any;
        assert.equal(full.capabilitiesV1.producer.surface, 'sdk');
        assert.equal(Object.keys(full.capabilitiesV1.actions).length, 18);
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

  test(`${era} summary preserves per-variant eligibility for Wayland JPEG and unsupported modes`, { timeout: 60_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-budget-jpeg-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await fixtureAdapter(root);
    const options = { workspaceDir: root, adapterPath: fixture.adapter, actionPermissions: resolveActionPermissions({ actionProfile: 'observation-only' }) };
    const call = await connect(t, era, options);
    const core = createDesktopClient({ ...options, scope: { principalId: 'budget', sessionId: era }, auditSink: async () => {}, surface: 'mcp' });
    const screenshots: Record<string, any> = {};
    for (const [name, jpeg] of [['wayland-grim-jpeg-disabled', false], ['wayland-grim-jpeg-enabled', true]] as const) {
      await fixture.select(name);
      const report = ((await core.execute({ action: 'health' }, { callId: 'core' })).details as any).capabilitiesV1;
      const controls = discoverCapabilityControls(report).find(control => control.action === 'screenshot')!;
      const reference = controls.variants.find(variant => variant.mode === 'screen' && variant.parameters.format?.values?.includes('jpg'))!;
      assert.equal(reference.enabled, jpeg, `${name}: reference eligibility`);
      const summary = (await call({ action: 'health' })).structuredContent.capabilitySummaryV1.actions.screenshot;
      screenshots[name] = summary;
      const jpg = summary.variants.filter((variant: any) => variant.modes?.includes('screen') && variant.formats?.includes('jpg'));
      assert.equal(jpg.length, 1, name);
      assert.deepEqual([jpg[0].enabled, jpg[0].state, jpg[0].reasonCodes],
        jpeg ? [true, 'available', undefined] : [false, 'unsupported', ['ENCODING_BUILD_DISABLED']], name);
      const usable = summary.variants.filter((variant: any) => variant.enabled);
      assert.deepEqual([...new Set(usable.flatMap((variant: any) => variant.modes ?? []))], ['screen'], name);
      assert.equal(usable.some((variant: any) => variant.selectors), false, name);
      assert.deepEqual(usable.flatMap((variant: any) => variant.formats).sort(), jpeg ? ['jpg', 'png'] : ['png'], name);
    }
    assert.notDeepEqual(screenshots['wayland-grim-jpeg-disabled'], screenshots['wayland-grim-jpeg-enabled']);
  });

  test(`${era} discovery fits the budget with a missing adapter, denied doctor, or full profile`, { timeout: 60_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-budget-edge-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await fixtureAdapter(root);
    await fixture.select('x11');
    const cases = [
      { label: 'missing adapter', adapterPath: join(root, 'missing-adapter'), actionPermissions: resolveActionPermissions({ actionProfile: 'observation-only' }) },
      { label: 'doctor denied', adapterPath: fixture.adapter, actionPermissions: resolveActionPermissions({ allowedActions: ['health'] }) },
      { label: 'full profile', adapterPath: fixture.adapter, actionPermissions: resolveActionPermissions() },
    ];
    for (const { label, ...options } of cases) {
      const call = await connect(t, era, { workspaceDir: root, ...options });
      const core = createDesktopClient({ workspaceDir: root, ...options, scope: { principalId: 'budget', sessionId: era }, auditSink: async () => {}, surface: 'mcp' });
      for (const action of ['health', 'doctor'] as const) {
        assertFaithfulSummary((await call({ action })).structuredContent, (await core.execute({ action }, { callId: 'core' })).details, `${era} ${label} ${action}`);
      }
      if (label === 'full profile') assert.equal((await call({ action: 'file-write', path: 'unapproved', content: 'x' })).structuredContent.status, 'needsApproval');
    }
  });
}
