// Real pinned gateway + local deterministic model transport; no live provider or desktop input.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, open, symlink, access, rename, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.argv[4] ?? repo);
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
const WebSocket = createRequire(join(host, "package.json"))("ws");
const cases = new Map();
const requests = [];
const model = createServer(async (req, res) => {
  try {
    let input = ""; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    const messages = body.messages ?? [];
    const userIndex = messages.findLastIndex(m => m.role === "user" && JSON.stringify(m.content).includes("QUALIFICATION_CASE:"));
    const marker = JSON.stringify(messages[userIndex]?.content).match(/QUALIFICATION_CASE:([a-z0-9-]+)/)?.[1];
    assert.ok(marker && cases.has(marker), `Unexpected model request ${req.url}`);
    const plan = cases.get(marker);
    const finished = messages.slice(userIndex + 1).some(m => m.role === "tool");
    requests.push({ case: marker, url: req.url, tools: (body.tools ?? []).map(t => t.function?.name), finished });
    await save("model-requests.json", requests);
    const toolCall = { index: 0, id: `call_${marker}`, type: "function", function: { name: plan.tool ?? "computer_use", arguments: JSON.stringify(plan.args) } };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-${marker}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant" });
    chunk(finished ? { content: `Qualification ${marker} complete.` } : { tool_calls: [toolCall] });
    chunk({}, finished ? "stop" : "tool_calls");
    res.end("data: [DONE]\n\n");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await listen(model);
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
  plugins: { allow: ["opencoven-desktop-use"], load: { paths: [pluginRoot] }, slots: { memory: "none" } },
  skills: { allowBundled: [] }, tools: { profile: "minimal" },
  models: { mode: "merge", providers: { qualification: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "disposable-qualification-key", api: "openai-completions",
    models: [{ id: "fixture", name: "Local qualification transport", reasoning: false, input: ["text"],
      contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } },
  agents: {
    defaults: { workspace, skipBootstrap: true, model: { primary: "qualification/fixture" }, timeoutSeconds: 420, heartbeat: { every: "0m" } },
    list: [
      { id: "computer-use", default: true, workspace, agentDir, tools: template.tools },
      { id: "legacy-qualification", workspace: legacyWorkspace, agentDir: join(root, "state/agents/legacy-qualification/agent"), tools: { ...template.tools, allow: ["desktop_use"] } },
    ],
  },
};
const configPath = join(root, "openclaw.json"); await save("openclaw.json", config);
const log = await open(join(root, "console.log"), "w", 0o600);
const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { OPENCLAW_STATE_DIR: join(root, "state"), OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_HOME: join(root, "home"), OPENCLAW_PLUGIN_LOAD_PROFILE: "1", OPENCLAW_LIVE_GATEWAY: "1", OPENCLAW_LIVE_GATEWAY_PROVIDERS: "qualification" });
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
  await save("runtime-version.json", { package: pkg.version, server: hello.server.version, defaultBundledPlugins: true, providerDiscovery: "qualification only via upstream live-gateway configuration" });
  const session = "agent:computer-use:qualification";
  await rpc("sessions.patch", { key: session, label: "qualification" });
  const inventory = await rpc("tools.effective", { sessionKey: session }); await save("effective-tools.json", inventory);
  assert.deepEqual(inventory.groups.flatMap(g => g.tools.map(t => t.id)), ["computer_use"]);
  async function httpInvoke(tool, args, sessionKey = session) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, response => {
        let body = "";
        response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
        response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); } });
      });
      request.setTimeout(30000, () => request.destroy(new Error("HTTP invocation timed out")));
      request.on("error", reject); request.end(JSON.stringify({ tool, args, sessionKey }));
    });
  }
  const health = await httpInvoke("computer_use", { action: "health" }); await save("health.json", health);
  assert.equal(health.status, 200); assert.deepEqual(health.body.result.details.agent.toolPolicy, template.tools);
  for (const name of ["exec", "bash", "shell", "apply_patch", "desktop_use"]) assert.equal((await httpInvoke(name, {})).status, 404, name);
  async function runCase(name, args, decision = "allow-once", sessionKey = session, tool = "computer_use", options = {}) {
    cases.set(name, { args, tool });
    const start = events.length;
    const accepted = await rpc("agent", { message: `QUALIFICATION_CASE:${name}`, agentId: sessionKey.split(":")[1], sessionKey, idempotencyKey: randomUUID(), deliver: false, timeout: 420 });
    const completed = rpc("agent.wait", { runId: accepted.runId, timeoutMs: 420000 }, 430000);
    completed.catch(() => {});
    options.onAccepted?.(accepted);
    if (decision !== "none") {
      const approval = await until(() => events.slice(start).find(e => e.event === "plugin.approval.requested" && e.payload.request.toolCallId?.includes(name)), 45000);
      await save(`${name}-approval.json`, approval.payload);
      await options.beforeDecision?.(approval.payload);
      if (decision !== "expire") await rpc("plugin.approval.resolve", { id: approval.payload.id, decision });
    }
    const outcome = await completed; await save(`${name}-outcome.json`, outcome);
    const history = await rpc("chat.history", { sessionKey, limit: 100 }); await save(`${name}-history.json`, history);
    if (!options.abort) assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    return { history, events: events.slice(start) };
  }
  const toolResult = (history, name = "computer_use") => {
    const message = history.messages?.findLast(m => m.role === "toolResult" && m.toolName === name);
    assert.ok(message, `No ${name} tool result in gateway history`);
    const text = message.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
    return JSON.parse(text);
  };
  const noFile = async path => assert.rejects(access(path), { code: "ENOENT" });
  const initial = await runCase("initial-stop", { action: "stop" }, "none");
  assert.equal(toolResult(initial.history).status, "success");
  const secret = "qualification-private-content-4c925ce0";
  const external = join(root, "external"); await mkdir(external);
  await symlink(external, join(workspace, "alias"));
  const allowedPath = join(external, "allowed.txt");
  const allowed = await runCase("canonical-allow", { action: "file-write", path: "alias/allowed.txt", content: secret }, "allow-once", session, "computer_use", {
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
  const rebind = await runCase("target-rebind", { action: "file-write", path: "real/note.txt", content: secret }, "allow-once", session, "computer_use", {
    beforeDecision: async () => { await rename(real, join(workspace, "old")); await symlink(rebound, real); },
  });
  assert.equal(toolResult(rebind.history).status, "needsApproval"); await noFile(join(rebound, "note.txt"));
  const legacySession = "agent:legacy-qualification:qualification";
  await rpc("sessions.patch", { key: legacySession });
  const legacyInventory = await rpc("tools.effective", { sessionKey: legacySession }); await save("legacy-effective-tools.json", legacyInventory);
  assert.deepEqual(legacyInventory.groups.flatMap(g => g.tools.map(t => t.id)), ["desktop_use"]);
  const legacy = await runCase("legacy-denied", { action: "file-write", path: "legacy.txt", content: secret, confirm: true }, "deny", legacySession, "desktop_use");
  await noFile(join(legacyWorkspace, "legacy.txt"));
  const helper = join(root, "stalled-helper.cjs");
  await writeFile(helper, "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);\n");
  const processGone = async pid => until(() => { try { process.kill(pid, 0); return false; } catch (e) { assert.equal(e.code, "ESRCH"); return true; } }, 2000);
  for (const mode of ["stop", "abort"]) {
    const caseName = `owned-${mode}`, key = `agent:computer-use:${caseName}`, ready = join(root, `${caseName}.pid`);
    await rpc("sessions.patch", { key });
    let run;
    const active = runCase(caseName, { action: "shell", command: process.execPath, args: [helper, ready], timeoutMs: 30000 }, "allow-once", key, "computer_use", { abort: mode === "abort", onAccepted: accepted => run = accepted });
    active.catch(() => {});
    const pid = await until(async () => { const n = Number(await readFile(ready, "utf8")); return Number.isSafeInteger(n) && n > 0 ? n : undefined; }, 45000);
    const otherSessionStop = await httpInvoke("computer_use", { action: "stop" }, session);
    assert.equal(otherSessionStop.body.result.details.cancellationRequested, 0);
    const otherAgentStop = await httpInvoke("desktop_use", { action: "stop" }, legacySession);
    assert.equal(otherAgentStop.body.result.details.cancellationRequested, 0);
    process.kill(pid, 0);
    const start = Date.now();
    const cancellation = mode === "stop" ? await httpInvoke("computer_use", { action: "stop" }, key) : await rpc("sessions.abort", { key, runId: run.runId });
    await processGone(pid);
    const result = await active;
    if (mode === "stop") { assert.equal(cancellation.body.result.details.cancellationRequested, 1); assert.equal(toolResult(result.history).status, "cancelled"); }
    await save(`${caseName}-cancellation.json`, { cancellation, elapsedMs: Date.now() - start, helperGone: true });
  }
  const expiryStarted = Date.now();
  const expired = await runCase("expired-write", { action: "file-write", path: "expired.txt", content: secret }, "expire");
  const expiryApproval = JSON.parse(await readFile(join(root, "expired-write-approval.json"), "utf8"));
  assert.equal(expiryApproval.expiresAtMs - expiryApproval.createdAtMs, 300000);
  assert.ok(Date.now() - expiryStarted >= 299000, "Use the real configured approval expiry");
  await noFile(join(workspace, "expired.txt"));
  const audit = await readFile(join(dirname(agentDir), "audit/computer-use.jsonl"), "utf8");
  assert.ok(!audit.includes(secret));
  const records = audit.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.some(r => r.action === "file-write" && r.result.status === "success"));
  assert.ok(records.some(r => r.action === "shell" && r.result.status === "cancelled"));
  await save("audit-summary.json", { records: records.length, privateContentAbsent: true, outcomes: records.map(r => ({ action: r.action, status: r.result.status })) });
  await save("events.json", events);
  console.log(`Gateway qualification checkpoint: ${root}`);
} finally {
  await save("events.json", events);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  socket?.terminate(); model.closeAllConnections(); await new Promise(r => model.close(r));
  if (!gatewayExit) gateway.kill("SIGTERM");
  await until(() => gatewayExit, 10000).catch(() => gateway.kill("SIGKILL"));
  await log.close();
}
