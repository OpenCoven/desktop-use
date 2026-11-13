import { createCapabilitiesFixture, discoveryCallsForPlan, inspectDiscoveryTransport, correlateDiscoveryReplay, inspectDiscoveryHistory, QUALIFICATION_CONTEXT_TOKENS, DISCOVERY_TRUNCATION_MARKER } from "./gateway-capabilities-fixture.mjs";
import { assertPackedMetadata } from "./packed-metadata.mjs";
import { createImageFixture, inspectProviderImage } from "./gateway-image-fixture.mjs";
import { COMPUTER_USE_TOOL_NAME, DESKTOP_USE_TOOL_NAME } from "../src/tool-names.ts";
// Real pinned gateway + local deterministic model transport; no live provider or desktop input.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, open, symlink, access, rename, realpath, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.argv[4] ?? repo);
const profile = process.argv[5] ?? "full";
const lane = process.argv[6] ?? "complete";
assert.ok(["complete", "capabilities"].includes(lane));
const permissionConfigs = {
  full: { actionProfile: "full" },
  "observation-only": { actionProfile: "observation-only" },
  "desktop-only": { actionProfile: "desktop-only" },
  "stop-only": { actionProfile: "full", allowedActions: [] },
};
assert.ok(Object.hasOwn(permissionConfigs, profile), "Profile must be full, observation-only, desktop-only, or stop-only");
const root = resolve(process.argv[2] ?? `/tmp/desktopuse-gateway-receipt-${Date.now()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const save = async (name, data) => writeFile(join(root, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await delay(100);
  }
  throw error ?? new Error("Condition did not converge before deadline");
}
const listen = server => new Promise(r => server.listen(0, "127.0.0.1", r));
const host = await realpath(resolve(process.argv[3] ?? join(repo, "node_modules/openclaw")));
const pkg = JSON.parse(await readFile(join(host, "package.json"), "utf8"));
assert.equal(pkg.version, "2026.4.26");
const hostRequire = createRequire(join(host, "package.json"));
const WebSocket = hostRequire("ws");
assert.equal(process.env.OPENCLAW_IMAGE_BACKEND ?? "sharp", "sharp", "Frame qualification requires the pinned Sharp backend");
assert.equal(hostRequire("sharp/package.json").version, "0.34.5");
await save("host-image-identity.json", { host, openclawVersion: pkg.version, sharpVersion: "0.34.5", nodeVersion: process.version, imageBackend: "sharp" });
// Host replay normalizes tool-call ids; keep batched fixture ids alphanumeric.
const batchCallId = name => `call${name.replace(/[^a-zA-Z0-9]/g, "")}`;
const cases = new Map();
const requests = [];
const modelErrors = [];
const modelSchemas = {};
const imageFixture = await createImageFixture(repo, root);
const capabilitiesFixture = await createCapabilitiesFixture(repo, root, imageFixture.adapter);
const canonicalActions = ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "shell", "file-list", "file-read", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch"];
const legacyActions = { permissions: "doctor", see: "inspect", capture: "screenshot", type: "type-text", press: "keypress" };
const profileActions = {
  full: canonicalActions,
  "observation-only": ["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read"],
  "desktop-only": ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch"],
  "stop-only": ["stop"],
}[profile];
const visibleAliases = Object.keys(legacyActions).filter(action => profileActions.includes(legacyActions[action]));
const model = createServer(async (req, res) => {
  try {
    let input = ""; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    const messages = body.messages ?? [];
    const userIndex = messages.findLastIndex(m => m.role === "user" && JSON.stringify(m.content).includes("QUALIFICATION_CASE:"));
    const marker = JSON.stringify(messages[userIndex]?.content ?? "").match(/QUALIFICATION_CASE:([a-z0-9-]+)/)?.[1];
    assert.ok(marker && cases.has(marker), `Unexpected model request ${req.url}`);
    const plan = cases.get(marker);
    assert.deepEqual((body.tools ?? []).map(t => t.function?.name), [plan.tool ?? COMPUTER_USE_TOOL_NAME], "Actual model tool inventory");
    const definition = body.tools[0].function;
    const actionSchema = definition.parameters.properties.action;
    const values = actionSchema.enum ?? actionSchema.anyOf?.map(branch => branch.const);
    assert.deepEqual([...values].sort(), [...profileActions, ...visibleAliases].sort(), "Model-visible bounded compatibility vocabulary");
    for (const legacy of visibleAliases) assert.ok(actionSchema.description.includes(`${legacy} -> ${legacyActions[legacy]}`));
    if (visibleAliases.length) assert.ok(actionSchema.description.includes("0.2.0"));
    if (profile === "stop-only") assert.ok(actionSchema.description.includes("Stop-only"));
    modelSchemas[definition.name] = definition.parameters;
    await save("model-tool-schemas.json", modelSchemas);
    const currentToolResults = messages.slice(userIndex + 1).filter(m => m.role === "tool");
    const finished = plan.replaySourceCase ? true : currentToolResults.length > 0;
    if (plan.replaySourceCase) {
      assert.equal(currentToolResults.length, 0, "Replay turn must not create a tool result");
      assert.equal(plan.responses ?? 0, 0, "Replay is a single no-tool provider response");
    }
    if (finished && plan.imageKind) await save(`provider-image-${plan.replaySourceCase ? "large-replay" : plan.imageKind}.json`, await inspectProviderImage(body, imageFixture.fixtures[plan.imageKind], { currentCase: marker, ...(plan.replaySourceCase ? { stage: "history-replay", sourceCase: plan.replaySourceCase } : {}) }));
    if (finished) {
      const calls = discoveryCallsForPlan(plan, { currentCase: marker, batchCallId, allowedActions: profileActions, canonicalAliases: legacyActions, legacyToolName: DESKTOP_USE_TOOL_NAME, canonicalToolName: COMPUTER_USE_TOOL_NAME });
      const receipts = calls.length ? inspectDiscoveryTransport(body, { currentCase: marker, calls, contextWindowTokens: QUALIFICATION_CONTEXT_TOKENS }) : [];
      if (receipts.length) await save(`${marker}-discovery-provider-transport.json`, receipts);
      if (marker === "capability-model-profile") {
        if (profile === "stop-only") {
          const content = currentToolResults.at(-1)?.content;
          assert.equal(typeof content, "string");
          assert.equal(JSON.parse(content).status, "success");
          await save("capability-model-provider-transport.json", { profile, stage: "provider-current-turn", textChars: content.length, sha256: createHash("sha256").update(content).digest("hex"), truncated: false, fullCapabilityJsonTransport: false, smallStopResultComplete: true });
        } else {
          assert.equal(receipts[0]?.truncated, true, "Preserved discovery JSON exceeds the default host live-text limit");
          await save("capability-model-provider-transport.json", { profile, ...receipts[0], structuredHttpReportComplete: true });
        }
      }
    }
    // The host can run a batch in parallel: execute Stop on the next provider
    // response so it cannot cancel the observations being qualified alongside it.
    const stopAfterBatch = plan.stopAfterBatch && finished && !plan.stopSent;
    if (stopAfterBatch) plan.stopSent = true;
    plan.responses = (plan.responses ?? 0) + 1;
    if (plan.calls) assert.ok(plan.responses <= (plan.stopAfterBatch ? 3 : 2), "Restricted fixture must finish its bounded response sequence");
    requests.push({ case: marker, url: req.url, tools: (body.tools ?? []).map(t => t.function?.name), finished });
    await save("model-requests.json", requests);
    if (!finished) plan.onModelRequest?.();
    const toolCall = { index: 0, id: `call_${marker}`, type: "function", function: { name: plan.tool ?? COMPUTER_USE_TOOL_NAME, arguments: JSON.stringify(plan.args) } };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-${marker}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant" });
    const toolCalls = stopAfterBatch ? [{ index: 0, id: batchCallId("restricted-allowed-stop"), type: "function", function: { name: plan.tool ?? COMPUTER_USE_TOOL_NAME, arguments: JSON.stringify({ action: "stop" }) } }] : plan.calls ? plan.calls.map((call, index) => ({ index, id: batchCallId(call.name), type: "function",
      function: { name: plan.tool ?? COMPUTER_USE_TOOL_NAME, arguments: JSON.stringify(call.args) } })) : [toolCall];
    chunk(finished && !stopAfterBatch ? { content: `Qualification ${marker} complete.` } : { tool_calls: toolCalls });
    chunk({}, finished && !stopAfterBatch ? "stop" : "tool_calls");
    res.end("data: [DONE]\n\n");
  } catch (e) {
    modelErrors.push({ message: String(e) });
    await save("model-errors.json", modelErrors);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "FIXTURE_REQUEST_REJECTED", message: "Fixture model request rejected." } }));
  }
});
await listen(model);
const invalidModelResponse = await new Promise((resolve, reject) => {
  const request = httpRequest(`http://127.0.0.1:${model.address().port}/qualification-invalid-request`, { method: "POST" }, response => {
    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
    response.on("end", () => resolve({ status: response.statusCode, body }));
  });
  request.setTimeout(5000, () => request.destroy(new Error("Invalid-model probe timed out")));
  request.on("error", reject); request.end(JSON.stringify({ messages: [{ role: "user", content: "QUALIFICATION_CASE:unregistered-case" }] }));
});
assert.equal(invalidModelResponse.status, 500);
assert.deepEqual(JSON.parse(invalidModelResponse.body), { error: { code: "FIXTURE_REQUEST_REJECTED", message: "Fixture model request rejected." } });
await save("model-error-sanitization.json", { status: 500, internalDiagnosticsAbsent: true });
const reservation = createServer(); await listen(reservation);
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const token = randomBytes(24).toString("hex");
const workspace = join(root, "workspace");
const agentDir = join(root, "state/agents/computer-use/agent");
const legacyWorkspace = join(root, "legacy-workspace"); await mkdir(legacyWorkspace);
await mkdir(workspace, { recursive: true });
const template = JSON.parse(await readFile(join(pluginRoot, "agents/computer-use/openclaw-agent.json"), "utf8"));
const config = {
  gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
  logging: { file: join(root, "gateway.jsonl"), level: "info" },
  discovery: { mdns: { mode: "off" } }, browser: { enabled: false }, cron: { enabled: false },
  canvasHost: { enabled: false }, update: { checkOnStart: false },
  plugins: { allow: ["opencoven-desktop-use"], load: { paths: [pluginRoot] }, slots: { memory: "none" }, entries: { "opencoven-desktop-use": { enabled: true, config: permissionConfigs[profile] } } },
  skills: { allowBundled: [] }, tools: { profile: "minimal" },
  models: { mode: "merge", providers: { qualification: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "disposable-qualification-key", api: "openai-completions",
    models: [{ id: "fixture", name: "Local qualification transport", reasoning: false, input: ["text", "image"],
      contextWindow: QUALIFICATION_CONTEXT_TOKENS, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } },
  agents: {
    defaults: { workspace, skipBootstrap: true, model: { primary: "qualification/fixture" }, timeoutSeconds: 420, heartbeat: { every: "0m" } },
    list: [
      { id: "computer-use", default: true, workspace, agentDir, tools: template.tools },
      { id: "minimal-qualification", workspace, agentDir: join(root, "state/agents/minimal-qualification/agent"), tools: { ...template.tools, profile: "minimal" } },
      { id: "legacy-qualification", workspace: legacyWorkspace, agentDir: join(root, "state/agents/legacy-qualification/agent"), tools: { ...template.tools, allow: [DESKTOP_USE_TOOL_NAME] } },
    ],
  },
};
const configPath = join(root, "openclaw.json"); await save("openclaw.json", config);
const log = await open(join(root, "console.log"), "w", 0o600);
const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const unavailableAdapter = join(root, "deliberately-unavailable-desktop-adapter");
await assert.rejects(access(unavailableAdapter), { code: "ENOENT" });
Object.assign(env, { OPENCLAW_IMAGE_BACKEND: process.env.OPENCLAW_IMAGE_BACKEND ?? "sharp", OPENCLAW_STATE_DIR: join(root, "state"), OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_HOME: join(root, "home"), OPENCLAW_PLUGIN_LOAD_PROFILE: "1", OPENCLAW_LIVE_GATEWAY: "1", OPENCLAW_LIVE_GATEWAY_PROVIDERS: "qualification", COVEN_DESKTOP_USE_BIN: capabilitiesFixture.adapter, COVEN_HOME: join(root, "coven-home") });
await save("action-permissions.json", { profile, trustedConfig: permissionConfigs[profile], expectedActions: profileActions, expectedAliases: visibleAliases });
await save("adapter-fixture.json", { mode: "synthetic-capture-only-when-harness-enabled", nativePlatform: process.platform, realRustBinary: imageFixture.binary, nonCaptureUnavailable: true, graphicalEffects: false, liveProvider: false });
// Refuse to start a gateway if this package would escape the explicit state root.
// Verify byte-identical compiled runtime, then use the checkout's installed SDK peer for a
// dry resolver call with no audit write or gateway/profile initialization.
for (const file of ["index.js", "openclaw.plugin.json", "src/computer-use-audit.ts", "src/computer-use-agent.ts", "src/tool-names.ts", "src/action-permissions.ts", "src/computer-use-actions.ts", "src/computer-use-policy.ts", "src/plugin-tool.ts", "src/capabilities.ts", "src/host-actions.ts", "src/observation.ts", "src/file-actions.ts", "contracts/v1/observation.schema.json", "contracts/v1/capabilities.schema.json", "contracts/v1/canonical-actions.json", "contracts/v1/canonical-actions.schema.json"]) {
  const runtimeFile = file === "openclaw.plugin.json" ? file : "dist/" + file.replace(/\.ts$/, ".js");
  assert.deepEqual(await readFile(join(repo, runtimeFile)), await readFile(join(pluginRoot, runtimeFile)), `Packed runtime differs: ${runtimeFile}`);
}
// Compare complete metadata, allowing only pnpm pack's known prepack removal.
assertPackedMetadata(JSON.parse(await readFile(join(repo, "package.json"), "utf8")), JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8")));
const auditProbe = spawnSync(process.execPath, ["--import", createRequire(join(repo, "package.json")).resolve("tsx"), "--input-type=module", "-e",
  "const audit = await import(process.argv[1]); console.log(JSON.stringify(['computer-use','legacy-qualification'].map(agentId => audit.resolveComputerUseAuditLogPath({agentId}))));",
  pathToFileURL(join(repo, "src/computer-use-audit.ts")).href,
], { cwd: repo, env, encoding: "utf8" });
assert.equal(auditProbe.status, 0, auditProbe.stderr);
assert.deepEqual(JSON.parse(auditProbe.stdout.trim()), [join(root, "state/agents/computer-use/audit/computer-use.jsonl"), join(root, "state/agents/legacy-qualification/audit/computer-use.jsonl")]);
await save("audit-path-preflight.json", { isolated: true });
const gateway = spawn(process.execPath, [join(host, "openclaw.mjs"), "gateway", "run"], { cwd: repo, env, stdio: ["ignore", log.fd, log.fd] });
let gatewayExit; gateway.on("exit", (code, signal) => { gatewayExit = { code, signal }; });
let socket;
const pending = new Map(); const events = [];
try {
  await until(async () => {
    assert.equal(gatewayExit, undefined, `Gateway exited: ${JSON.stringify(gatewayExit)}`);
    return readFile(join(root, "console.log"), "utf8").then(text => text.includes("[gateway] ready"));
  }, 600000);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const rpc = (method, params = {}, timeoutMs = 600000) => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  };
  const hello = await new Promise((resolve, reject) => {
    socket.addEventListener("error", reject);
    socket.addEventListener("message", async ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.type === "event") {
        events.push(frame);
        if (frame.event === "connect.challenge") {
          rpc("connect", { minProtocol: 3, maxProtocol: 3,
            client: { id: "gateway-client", version: pkg.version, platform: process.platform, mode: "backend" },
            role: "operator", scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
            caps: ["tool-events"], auth: { token },
          }).then(resolve, reject);
        }
      } else if (frame.type === "res" && pending.has(frame.id)) {
        const waiter = pending.get(frame.id); clearTimeout(waiter.timer); pending.delete(frame.id);
        frame.ok ? waiter.resolve(frame.payload) : waiter.reject(new Error(JSON.stringify(frame.error)));
      }
    });
  });
  await save("runtime-version.json", { package: pkg.version, server: hello.server.version, defaultBundledPlugins: true, implicitModelDiscovery: "qualification only via upstream live-gateway configuration" });
  const session = "agent:computer-use:qualification";
  await rpc("sessions.patch", { key: session, label: "qualification" });
  const inventory = await rpc("tools.effective", { sessionKey: session }); await save("effective-tools.json", inventory);
  assert.deepEqual(inventory.groups.flatMap(g => g.tools.map(t => t.id)), [COMPUTER_USE_TOOL_NAME]);
  async function httpInvoke(tool, args, sessionKey = session) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, response => {
        let body = "";
        response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
        response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); } });
      });
      request.setTimeout(180000, () => request.destroy(new Error("HTTP invocation timed out")));
      request.on("error", reject); request.end(JSON.stringify({ tool, args, sessionKey }));
    });
  }
  if (profile === "full") {
    const minimalSession = "agent:minimal-qualification:qualification";
    await rpc("sessions.patch", { key: minimalSession });
    const minimalInventory = await rpc("tools.effective", { sessionKey: minimalSession });
    await save("minimal-effective-tools.json", minimalInventory);
    assert.equal(minimalInventory.profile, "minimal");
    assert.deepEqual(minimalInventory.groups, []);
    assert.equal((await httpInvoke(COMPUTER_USE_TOOL_NAME, { action: "stop" }, minimalSession)).status, 404);
    const health = await httpInvoke(COMPUTER_USE_TOOL_NAME, { action: "health" }); await save("health.json", health);
    assert.equal(health.status, 200); assert.deepEqual(health.body.result.details.agent.toolPolicy, template.tools);
    assert.deepEqual(health.body.result.details.actionPermissions.allowedActions, profileActions);
    assert.equal(health.body.result.details.actionPermissions.gatewayAuthorization, "not-reported");
    for (const name of ["exec", "bash", "shell", "apply_patch", DESKTOP_USE_TOOL_NAME]) assert.equal((await httpInvoke(name, {})).status, 404, name);
  }
  async function runCase(name, args, decision = "allow-once", sessionKey = session, tool = COMPUTER_USE_TOOL_NAME, options = {}) {
    const startedAt = Date.now();
    const timing = {};
    let modelRequested;
    const modelReady = new Promise(resolve => modelRequested = resolve);
    cases.set(name, { args, tool, calls: options.calls, stopAfterBatch: options.stopAfterBatch, imageKind: options.imageKind, replaySourceCase: options.replaySourceCase, onModelRequest: () => { timing.modelRequestedMs = Date.now() - startedAt; modelRequested(); } });
    const start = events.length;
    const accepted = await rpc("agent", { message: `QUALIFICATION_CASE:${name}`, agentId: sessionKey.split(":")[1], sessionKey, idempotencyKey: randomUUID(), deliver: false, timeout: 420 });
    timing.acceptedMs = Date.now() - startedAt;
    const completed = rpc("agent.wait", { runId: accepted.runId, timeoutMs: 420000 }, 430000);
    completed.catch(() => {});
    options.onAccepted?.(accepted);
    if (decision !== "none") {
      // Cold per-agent provider initialization precedes the first model request.
      // Keep it under the existing agent deadline, not the approval-delivery window.
      await Promise.race([modelReady, completed.then(outcome => { throw new Error(`Agent ${name} ended before a model request: ${outcome.status}`); })]);
      for (const approvalName of options.approvalCalls ?? [name]) {
        const approvalCallId = options.calls ? batchCallId(approvalName) : `call_${approvalName}`;
        const approval = await until(() => events.slice(start).find(e => e.event === "plugin.approval.requested" && e.payload.request.toolCallId === approvalCallId), 45000);
        timing.approvalRequestedMs = Date.now() - startedAt;
        await save(`${approvalName}-timing.json`, timing);
        await save(`${approvalName}-approval.json`, approval.payload);
        await options.beforeDecision?.(approval.payload);
        if (decision !== "expire") await rpc("plugin.approval.resolve", { id: approval.payload.id, decision });
      }
    }
    const outcome = await completed; await save(`${name}-outcome.json`, outcome);
    await save(`${name}-timing.json`, timing);
    console.log(`Gateway agent finished ${name}: ${outcome.status}`);
    const history = await rpc("chat.history", { sessionKey, limit: 100 }); await save(`${name}-history.json`, history);
    if (!options.abort) assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    return { history, events: events.slice(start) };
  }
  const toolResult = (history, name = COMPUTER_USE_TOOL_NAME) => {
    const message = history.messages?.findLast(m => m.role === "toolResult" && m.toolName === name);
    assert.ok(message, `No ${name} tool result in gateway history`);
    const text = message.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
    return JSON.parse(text);
  };
  async function structuredDiscoveryReplay(name, result, args, tool = COMPUTER_USE_TOOL_NAME, sessionKey = session, toolCallId = `call_${name}`) {
    const message = result.history.messages?.findLast(message => message.role === "toolResult" && message.toolName === tool && message.toolCallId === toolCallId);
    assert.ok(message, "Missing exact discovery history tool call");
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (!text.includes(DISCOVERY_TRUNCATION_MARKER)) return JSON.parse(text);
    const transports = JSON.parse(await readFile(join(root, `${name}-discovery-provider-transport.json`), "utf8"));
    const transport = transports.find(receipt => receipt.toolCallId === toolCallId);
    const history = inspectDiscoveryHistory(message, { toolCallId });
    assert.ok(history.truncated, "Replay requires actual history truncation");
    assert.ok(transport?.truncated || transport?.fullCapabilityJsonTransport, "Replay requires verified provider-wire evidence");
    const agentId = sessionKey.split(":")[1];
    const auditPath = join(root, `state/agents/${agentId}/audit/computer-use.jsonl`);
    const auditRecords = (await readFile(auditPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const replay = await httpInvoke(tool, args, sessionKey);
    const details = correlateDiscoveryReplay({ transport, history, auditRecords, call: { toolCallId, action: args.action }, replay, scope: { agentId, sessionKey, auditPath } });
    await save(`${name}-${args.action}-structured-replay.json`, { stage: "separate-structured-http-replay", originalModelCall: { toolCallId, transport, history }, scope: { agentId, sessionKey, workspace: agentId === "legacy-qualification" ? legacyWorkspace : workspace }, response: replay, auditCorrelation: { action: details.action, status: details.status, success: details.success } });
    return details;
  }
  const noFile = async path => assert.rejects(access(path), { code: "ENOENT" });
  // Dedicated capabilities lane retains the complete lane's image, approval,
  // canonical-path, cancellation, legacy and audit assertions below unchanged.
  if (lane === "capabilities") {
    const receipts = [];
    for (const name of ["x11", "macos-permission-granted", "macos-permission-denied", "x11-empty", "missing-helper", "wayland-unknown", "wayland-unavailable", "windows", "schema-unknown", "missing-adapter"]) {
      await capabilitiesFixture.select(name);
      try {
        for (const action of ["health", "doctor"]) {
        const response = await httpInvoke(COMPUTER_USE_TOOL_NAME, { action });
        await save(`capability-${action}-${name}.json`, response);
        if (profile === "stop-only") { assert.equal(response.status, 403); receipts.push({ name, action, status: 403, profileDenied: true }); continue; }
        assert.equal(response.status, 200);
        const details = response.body.result.details;
        const report = details.capabilitiesV1;
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.producer.surface, "plugin");
        assert.deepEqual(report.actionPermissions.allowedActions, profileActions);
        assert.equal(report.actions.stop.policy.profile, "allowed");
        assert.equal(report.actions.stop.state, "available");
        assert.equal(report.actions["file-read"].state, "available");
        assert.equal(report.actions["file-read"].policy.profile, profile === "desktop-only" ? "denied" : "allowed");
        assert.ok(Object.values(report.actions).every(action => action.policy.gatewayPolicy === "not-reported"));
        if (process.platform === "darwin") for (const integration of ["clipboard-read", "clipboard-write", "browser-open", "app-launch"]) {
          const binary = report.actions[integration].evidence.find(evidence => evidence.kind === "binary");
          assert.equal(binary.status, "unknown", "Fixed Mac provider plans are not executable observations");
          assert.equal(binary.observedAtMs, undefined);
        }

        assert.equal(report.adapter.configuredPath, capabilitiesFixture.adapter);
        assert.equal(report.adapter.version, ["missing-adapter", "schema-unknown"].includes(name) ? null : "0.1.3");
        assert.equal(JSON.stringify(details.repairHints).includes("Screen Recording"), name === "macos-permission-denied");
        assert.equal(JSON.stringify(details.repairHints).includes("COVEN_DESKTOP_USE_BIN"), name === "missing-adapter");
        if (name === "x11-empty") assert.match(JSON.stringify(details.permissionFlow), /sudo apt install scrot xdotool wmctrl/);
        if (name === "missing-helper") assert.match(JSON.stringify(details.repairHints), /Peekaboo/);
        if (name === "schema-unknown") { assert.equal(details.code, "CAPABILITY_SCHEMA_UNSUPPORTED"); assert.equal(details.status, "error"); }
        else assert.equal(details.status, ["missing-adapter", "missing-helper"].includes(name) ? "error" : "success");
        assert.equal(Object.values(report.actions).some(action => action.evidence.some(e => e.kind === "actual-action" && e.status === "passed")), false);
        receipts.push({ name, action, status: details.status, phase: details.adapterInvocation.phase, version: report.adapter.version });
        }
      } finally { await capabilitiesFixture.restore(); }
    }
    // Actual provider-visible profile schema plus executor result for this lane.
    await capabilitiesFixture.select("x11");
    try {
      const result = await runCase("capability-model-profile", { action: profile === "stop-only" ? "stop" : "health" }, "none");
      const providerReceipt = JSON.parse(await readFile(join(root, "capability-model-provider-transport.json"), "utf8"));
      assert.equal(providerReceipt.truncated, profile !== "stop-only");
      assert.equal(result.events.some(event => event.event === "plugin.approval.requested"), false);
      if (profile !== "stop-only") {
        const health = await structuredDiscoveryReplay("capability-model-profile", result, { action: "health" });
        assert.equal(health.status, "success");
        const legacyDoctor = await runCase("capability-model-permissions", { action: "permissions" }, "none");
        const doctor = await structuredDiscoveryReplay("capability-model-permissions", legacyDoctor, { action: "permissions" });
        assert.equal(doctor.status, "success");
        assert.ok(doctor.deprecation.includes("permissions is deprecated; use doctor instead."));
      }
      // The host truncates large live tool text before provider/history delivery.
      // Keep that limit observable, and independently prove a small model result.
      const stopped = await runCase("capability-model-stop", { action: "stop" }, "none");
      assert.equal(toolResult(stopped.history).status, "success");
      assert.equal(stopped.events.some(event => event.event === "plugin.approval.requested"), false);
    } finally { await capabilitiesFixture.restore(); }
    const legacySession = "agent:legacy-qualification:capability";
    await rpc("sessions.patch", { key: legacySession });
    const legacy = await httpInvoke(DESKTOP_USE_TOOL_NAME, { action: "stop" }, legacySession);
    assert.equal(legacy.status, 200); assert.equal(legacy.body.result.details.status, "success");
    assert.ok(legacy.body.result.details.deprecation);
    await save("capability-legacy-stop.json", legacy);
    if (profile !== "full") {
      const action = profile === "desktop-only" ? "file-write" : "shell";
      const denied = await httpInvoke(COMPUTER_USE_TOOL_NAME, { action, path: "forbidden.txt", content: "qualification-private", command: process.execPath, confirm: true });
      assert.equal(denied.status, 403);
      await save("capability-profile-denied.json", denied);
      await noFile(join(workspace, "forbidden.txt"));
    }
    const records = (await readFile(join(dirname(agentDir), "audit/computer-use.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.every(record => profileActions.includes(record.action)));
    assert.ok(!JSON.stringify(records).includes("qualification-private"));
    await save("capability-summary.json", { lane, profile, pluginRoot, host, openclawVersion: pkg.version, synthetic: true, desktopEffects: false, liveProvider: false, receipts, modelSchema: true, modelStop: true, modelLegacyDoctor: profile !== "stop-only", providerTransport: JSON.parse(await readFile(join(root, "capability-model-provider-transport.json"), "utf8")), legacyStop: true, audit: { records: records.length, privateContentAbsent: true } });
    console.log(`Gateway capabilities ${profile} checkpoint: ${root}`);
  } else {

  if (profileActions.includes("screenshot")) {
    await writeFile(imageFixture.marker, "synthetic-only", { mode: 0o600 });
    try {
      for (const kind of ["png", "jpg", "large"]) {
        await writeFile(imageFixture.marker, kind, { mode: 0o600 });
        const image = await runCase(`synthetic-image-${kind}`, { action: "screenshot", mode: "screen", format: kind === "large" ? "png" : kind }, "none", session, COMPUTER_USE_TOOL_NAME, { imageKind: kind });
        assert.equal(toolResult(image.history).status, "success");
        assert.equal(image.events.some(e => e.event === "plugin.approval.requested"), false, "Default private staging adds no approval");
      }
    } finally { await rm(imageFixture.marker, { force: true }); }
    // Removing the marker disables captures before a distinct real agent turn.
    // This request must replay only the marked previous large-image turn.
    const beforeReplay = await rpc("chat.history", { sessionKey: session, limit: 100 });
    const toolCount = history => history.messages.filter(message => message.role === "toolResult").length;
    const replay = await runCase("synthetic-image-large-replay", undefined, "none", session, COMPUTER_USE_TOOL_NAME, { imageKind: "large", replaySourceCase: "synthetic-image-large" });
    assert.equal(toolCount(replay.history), toolCount(beforeReplay), "Replay must not manufacture another capture or tool effect");
    assert.equal(replay.events.some(event => event.event === "plugin.approval.requested"), false, "Replay adds no approval");
    assert.equal(requests.filter(request => request.case === "synthetic-image-large-replay").length, 1, "Replay uses exactly one actual provider request");
    await access(join(root, "provider-image-large.json"));
    await access(join(root, "provider-image-large-replay.json"));
  }

  if (profile === "full") {
    const initial = await runCase("initial-stop", { action: "stop" }, "none");
    assert.equal(toolResult(initial.history).status, "success");
  }
  const secret = "qualification-private-content-4c925ce0";
  if (profile !== "full") {
    // Restricted lanes exercise the actual packed plugin config and provider schema.
    // The unavailable adapter precludes graphical effects even for a regression.
    const fixtures = {
      health: {}, doctor: {}, inspect: {}, screenshot: {}, click: { on: "B1" },
      "type-text": { text: secret }, keypress: { keys: ["tab"] }, scroll: { direction: "down" }, focus: { app: "fixture" },
      shell: { command: process.execPath, args: ["-e", "require('fs').writeFileSync('forbidden-shell.txt','fixture')"] },
      "file-list": { path: "." }, "file-read": { path: "observation.txt", includeText: true },
      "file-write": { path: "forbidden-write.txt", content: secret },
      "clipboard-read": {}, "clipboard-write": { clipboardText: secret },
      "browser-open": { url: "https://example.invalid/qualification" }, "app-launch": { app: "desktopuse-nonexistent-fixture" },
    };
    await writeFile(join(workspace, "observation.txt"), "local observation fixture");
    const allowedActions = ["stop", "health", "doctor", "inspect", "screenshot", "file-list", "file-read"].filter(action => profileActions.includes(action));
    const deniedActions = [...canonicalActions, ...Object.keys(legacyActions)].filter(action => !profileActions.includes(legacyActions[action] ?? action));
    const gatedActions = profile === "desktop-only" ? ["clipboard-read", "clipboard-write", "browser-open", "app-launch", "type", "press"] : [];
    const callName = (kind, action) => `restricted-${kind}-${action}`;
    const calls = [
      ...allowedActions.filter(action => action !== "stop").map(action => ({ name: callName("allowed", action), args: { action, ...fixtures[action] } })),
      ...deniedActions.map(action => ({ name: callName("denied", action), args: { action, ...fixtures[legacyActions[action] ?? action], confirm: true } })),
      ...gatedActions.map(action => ({ name: callName("gated", action), args: { action, ...fixtures[legacyActions[action] ?? action], confirm: true } })),
    ];
    assert.equal(new Set([...calls.map(call => batchCallId(call.name)), batchCallId(callName("allowed", "stop"))]).size, calls.length + 1, "Each batched tool-call id must be unique");
    // A single real agent turn avoids rebuilding the unchanged provider catalog
    // for each vocabulary item. Every tool call keeps its own id and receipt.
    const batch = await runCase("restricted-matrix", { action: "stop" }, gatedActions.length ? "deny" : "none", session, COMPUTER_USE_TOOL_NAME,
      { calls, stopAfterBatch: true, approvalCalls: gatedActions.map(action => callName("gated", action)) });
    const resultFor = async (kind, action) => {
      const name = callName(kind, action);
      const message = batch.history.messages?.find(message => message.role === "toolResult" && message.toolCallId === batchCallId(name));
      assert.ok(message, `Missing ${name} tool result`);
      await save(`${name}-result.json`, message);
      return message.content?.filter(content => content.type === "text").map(content => content.text).join("\n");
    };
    const allowed = [];
    for (const action of allowedActions) {
      const details = ["health", "doctor"].includes(action) ? await structuredDiscoveryReplay("restricted-matrix", batch, { action, ...fixtures[action] }, COMPUTER_USE_TOOL_NAME, session, batchCallId(callName("allowed", action))) : JSON.parse(await resultFor("allowed", action));
      assert.equal(details.status, ["health", "doctor", "inspect", "screenshot"].includes(action) ? "error" : "success");
      if (action === "health") {
        assert.deepEqual(details.actionPermissions.allowedActions, profileActions);
        assert.equal(details.actionPermissions.gatewayAuthorization, "not-reported");
        await save("health.json", details);
      }
      allowed.push({ action, status: details.status });
    }
    const denied = [];
    for (const action of deniedActions) {
      assert.match(await resultFor("denied", action), /Validation failed|disabled by the trusted/, `Model must refuse ${action}`);
      assert.equal(batch.events.some(event => event.event === "plugin.approval.requested" && event.payload.request.toolCallId === batchCallId(callName("denied", action))), false);
      denied.push({ action, canonical: legacyActions[action] ?? action, modelDenied: true, approvalRequested: false });
    }
    for (const action of gatedActions) assert.equal(JSON.parse(await resultFor("gated", action)).error, "Denied by user");
    // Direct HTTP bypasses model schema validation. Representative excluded
    // shell/file/clipboard/launch families must still meet the trusted hook ceiling.
    const direct = [];
    for (const action of ["shell", "file-write", "clipboard-write", "browser-open"].filter(action => !profileActions.includes(action))) {
      const result = await httpInvoke(COMPUTER_USE_TOOL_NAME, { action, ...fixtures[action], confirm: true });
      assert.equal(result.status, 403, `Authenticated HTTP must refuse ${action}`);
      assert.match(result.body.error.message, /trusted.*action permissions/);
      await save(`restricted-denied-${action}-direct.json`, result);
      direct.push({ action, status: result.status });
    }
    const legacySession = "agent:legacy-qualification:qualification";
    await rpc("sessions.patch", { key: legacySession });
    const legacyStop = await httpInvoke(DESKTOP_USE_TOOL_NAME, { action: "stop" }, legacySession);
    assert.equal(legacyStop.status, 200); assert.equal(legacyStop.body.result.details.status, "success");
    await save("restricted-legacy-stop-direct.json", legacyStop);
    const legacyDenied = await httpInvoke(DESKTOP_USE_TOOL_NAME, { action: "shell", ...fixtures.shell, confirm: true }, legacySession);
    assert.equal(legacyDenied.status, 403);
    for (const path of [join(workspace, "forbidden-shell.txt"), join(workspace, "forbidden-write.txt"), join(legacyWorkspace, "forbidden-shell.txt")]) await noFile(path);
    const audit = await readFile(join(dirname(agentDir), "audit/computer-use.jsonl"), "utf8");
    assert.ok(!audit.includes(secret));
    const records = audit.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!records.some(record => record.toolCallId?.startsWith("callrestricteddenied")), "Schema/hook denials never reach executor audit");
    assert.ok(records.every(record => profileActions.includes(record.action)), "Only eligible actions reached executor audit");
    await save("audit-summary.json", { records: records.length, privateContentAbsent: true, outcomes: records.map(record => ({ action: record.action, status: record.result.status })) });
    await save("restricted-summary.json", { profile, allowed, denied, direct, retainedApprovals: gatedActions, batchedModelTurn: true, legacyStop: true, legacyDirectDenied: true, excludedFilesAbsent: true,
      audit: "Existing executor stream only; host schema/hook denials do not execute or create adapter audit records.", nativeEffects: false, liveProvider: false });
    console.log(`Gateway ${profile} qualification checkpoint: ${root}`);
  } else {
  const deprecations = [];
  for (const [legacy, canonical] of Object.entries(legacyActions)) {
    const args = { action: legacy, ...(legacy === "type" ? { text: secret } : legacy === "press" ? { keys: ["Tab"] } : {}) };
    const result = await runCase(`legacy-action-${legacy}`, args, ["type", "press"].includes(legacy) ? "allow-once" : "none");
    const details = canonical === "doctor" ? await structuredDiscoveryReplay(`legacy-action-${legacy}`, result, args) : toolResult(result.history);
    assert.equal(details.status, "error", "Unavailable fixture adapter must not claim desktop success");
    assert.equal(details.action, canonical);
    assert.ok(details.deprecation.includes(`${legacy} is deprecated; use ${canonical} instead.`));
    deprecations.push({ legacy, canonical, status: details.status, deprecation: details.deprecation });
  }
  await save("legacy-action-compatibility.json", deprecations);
  const external = join(root, "external"); await mkdir(external);
  await symlink(external, join(workspace, "alias"));
  const allowedPath = join(external, "allowed.txt");
  const allowed = await runCase("canonical-allow", { action: "file-write", path: "alias/allowed.txt", content: secret }, "allow-once", session, COMPUTER_USE_TOOL_NAME, {
    beforeDecision: async approval => {
      assert.ok(approval.request.description.includes(await realpath(external)));
      assert.ok(!approval.request.description.includes(secret));
      await noFile(allowedPath);
    },
  });
  assert.equal(toolResult(allowed.history).status, "success"); assert.equal(await readFile(allowedPath, "utf8"), secret);
  for (const [name, confirm] of [["denied-write", false], ["model-confirm-denied", true]]) {
    await runCase(name, { action: "file-write", path: `${name}.txt`, content: secret, confirm }, "deny");
    await noFile(join(workspace, `${name}.txt`));
  }
  const real = join(workspace, "real"), rebound = join(root, "rebound"); await mkdir(real); await mkdir(rebound);
  const rebind = await runCase("target-rebind", { action: "file-write", path: "real/note.txt", content: secret }, "allow-once", session, COMPUTER_USE_TOOL_NAME, {
    beforeDecision: async () => { await rename(real, join(workspace, "old")); await symlink(rebound, real); },
  });
  assert.equal(toolResult(rebind.history).status, "needsApproval"); await noFile(join(rebound, "note.txt"));
  const legacySession = "agent:legacy-qualification:qualification";
  await rpc("sessions.patch", { key: legacySession });
  const legacyInventory = await rpc("tools.effective", { sessionKey: legacySession }); await save("legacy-effective-tools.json", legacyInventory);
  assert.deepEqual(legacyInventory.groups.flatMap(g => g.tools.map(t => t.id)), [DESKTOP_USE_TOOL_NAME]);
  const legacy = await runCase("legacy-denied", { action: "file-write", path: "legacy.txt", content: secret, confirm: true }, "deny", legacySession, DESKTOP_USE_TOOL_NAME);
  await noFile(join(legacyWorkspace, "legacy.txt"));
  const legacyHealth = await runCase("legacy-tool-health", { action: "health" }, "none", legacySession, DESKTOP_USE_TOOL_NAME);
  const legacyHealthDetails = await structuredDiscoveryReplay("legacy-tool-health", legacyHealth, { action: "health" }, DESKTOP_USE_TOOL_NAME, legacySession);
  assert.ok(legacyHealthDetails.deprecation.includes(`${DESKTOP_USE_TOOL_NAME} is deprecated; use ${COMPUTER_USE_TOOL_NAME} instead.`));
  await save("legacy-tool-compatibility.json", { deprecation: legacyHealthDetails.deprecation });
  const clipboard = await runCase("legacy-clipboard-denied", { action: "clipboard-write", text: secret, confirm: true }, "deny");
  assert.ok(clipboard.events.some(e => e.event === "plugin.approval.requested"));
  assert.equal(toolResult(clipboard.history).status, "error");
  assert.equal(toolResult(clipboard.history).error, "Denied by user");
  // Gateway construction can load bundled provider metadata before dispatching
  // the tool; warm each control route before timing cancellation of live work.
  await httpInvoke(COMPUTER_USE_TOOL_NAME, { action: "stop" }, session);
  await httpInvoke(DESKTOP_USE_TOOL_NAME, { action: "stop" }, legacySession);
  const helper = join(workspace, "stalled-helper.cjs");
  await writeFile(helper, "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);\n");
  const processGone = async pid => until(() => { try { process.kill(pid, 0); return false; } catch (e) { assert.equal(e.code, "ESRCH"); return true; } }, 2000);
  for (const mode of ["stop", "abort"]) {
    const caseName = `owned-${mode}`, key = `agent:computer-use:${caseName}`, ready = join(workspace, `${caseName}.pid`);
    await rpc("sessions.patch", { key });
    await httpInvoke(COMPUTER_USE_TOOL_NAME, { action: "stop" }, key);
    let run;
    // Use the supported long-action budget: serial host catalog discovery on the
    // live cross-scope Stop routes can consume the default 30-second budget.
    const active = runCase(caseName, { action: "shell", command: process.execPath, args: ["stalled-helper.cjs", `${caseName}.pid`], timeoutMs: 120000 }, "allow-once", key, COMPUTER_USE_TOOL_NAME, { abort: mode === "abort", onAccepted: accepted => run = accepted });
    active.catch(() => {});
    const pid = await until(async () => { const n = Number(await readFile(ready, "utf8")); return Number.isSafeInteger(n) && n > 0 ? n : undefined; }, 45000);
    const otherSessionStop = await httpInvoke(COMPUTER_USE_TOOL_NAME, { action: "stop" }, session);
    assert.equal(otherSessionStop.body.result.details.cancellationRequested, 0);
    const otherAgentStop = await httpInvoke(DESKTOP_USE_TOOL_NAME, { action: "stop" }, legacySession);
    assert.equal(otherAgentStop.body.result.details.cancellationRequested, 0);
    process.kill(pid, 0);
    const start = Date.now();
    const cancellation = mode === "stop" ? await httpInvoke(COMPUTER_USE_TOOL_NAME, { action: "stop" }, key) : await rpc("sessions.abort", { key, runId: run.runId });
    const acceptedMs = Date.now() - start;
    await processGone(pid);
    const helperGoneMs = Date.now() - start;
    const result = await active;
    const cancellationAudit = await until(async () => {
      const records = (await readFile(join(dirname(agentDir), "audit/computer-use.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      return records.find(record => record.toolCallId === `call_${caseName}`);
    });
    assert.equal(cancellationAudit.result.status, "cancelled", `Audit the actual ${mode} outcome`);
    if (mode === "stop") { assert.equal(cancellation.body.result.details.cancellationRequested, 1); assert.equal(toolResult(result.history).status, "cancelled"); }
    await save(`${caseName}-cancellation.json`, { cancellation, acceptedMs, helperGoneMs, settledMs: Date.now() - start, helperGone: true });
  }
  console.log("Waiting for the gateway's real five-minute approval expiry.");
  const expiryStarted = Date.now();
  const expired = await runCase("expired-write", { action: "file-write", path: "expired.txt", content: secret }, "expire");
  const expiryApproval = JSON.parse(await readFile(join(root, "expired-write-approval.json"), "utf8"));
  assert.equal(expiryApproval.expiresAtMs - expiryApproval.createdAtMs, 300000);
  assert.ok(Date.now() - expiryStarted >= 299000, "Use the real configured approval expiry");
  await noFile(join(workspace, "expired.txt"));
  const audit = await readFile(join(dirname(agentDir), "audit/computer-use.jsonl"), "utf8");
  assert.ok(!audit.includes(secret));
  const records = audit.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(!records.some(record => record.toolCallId === "call_legacy-clipboard-denied"), "Gateway-denied clipboard input must not reach action execution/audit");
  assert.ok(records.some(r => r.action === "file-write" && r.result.status === "success"));
  assert.ok(records.some(r => r.action === "shell" && r.result.status === "cancelled"));
  await save("audit-summary.json", { records: records.length, privateContentAbsent: true, outcomes: records.map(r => ({ action: r.action, status: r.result.status })) });
  await save("events.json", events);
  console.log(`Gateway qualification checkpoint: ${root}`);
  }
  }
} finally {
  await capabilitiesFixture.restore();
  await save("events.json", events);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  socket?.terminate(); model.closeAllConnections(); await new Promise(r => model.close(r));
  if (!gatewayExit) gateway.kill("SIGTERM");
  await until(() => gatewayExit, 10000).catch(() => gateway.kill("SIGKILL"));
  await log.close();
}
