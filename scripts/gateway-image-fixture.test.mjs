import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { inspectProviderImage } from "./gateway-image-fixture.mjs";

test("provider proof checks the current image turn without confusing retained history", async () => {
  const bytes = await readFile(new URL("../contracts/v1/fixtures/images/valid.jpg", import.meta.url));
  const receipt = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/observations/valid-jpg.json", import.meta.url)));
  const body = { messages: [
    { role: "user", content: "prior capture" },
    { role: "tool", content: JSON.stringify({ observationV1: { invalid: true } }) },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,cHJpb3I=" } }] },
    { role: "user", content: "QUALIFICATION_CASE:synthetic-image-jpg" },
    { role: "tool", content: JSON.stringify({ observationV1: receipt }) },
    { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` } }] },
  ] };
  const proof = await inspectProviderImage(body, { bytes, mimeType: "image/jpeg", sha256: receipt.primaryImage.sha256 });
  assert.equal(proof.exactImageBytes, true);
  body.messages.at(-1).content[0].image_url.url = "data:image/jpeg;base64,d3Jvbmc=";
  await assert.rejects(inspectProviderImage(body, { bytes, mimeType: "image/jpeg", sha256: receipt.primaryImage.sha256 }));
});

test("large provider image preserves normalized landmarks after host resize", async () => {
  const { default: jpeg } = await import("jpeg-js");
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(new URL("../contracts/v1/fixtures/images/geometry-3200x1800.png", import.meta.url));
  const raw = Buffer.alloc(1200*675*4);
  for (let y=0;y<675;y++) for (let x=0;x<1200;x++) {
    const color = [Math.round(16+224*(x+.5)/1200),Math.round(16+224*(y+.5)/675),32+64*(x>=600)+128*(y>=337.5)];
    raw.set([...color,255],(y*1200+x)*4);
  }
  const converted = jpeg.encode({width:1200,height:675,data:raw},85).data;
  const receipt = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/observations/valid-png.json", import.meta.url)));
  receipt.primaryImage = { ...receipt.primaryImage, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sourceDimensions: { width:3200, height:1800 }, deliveredDimensions: { width:3200, height:1800 } };
  receipt.coordinateReference.sourceExtent = { x:0,y:0,width:3200,height:1800 };
  const body = { messages: [{ role:"user",content:"QUALIFICATION_CASE:large" },{role:"tool",content:JSON.stringify({observationV1:receipt})},{role:"user",content:[{type:"image_url",image_url:{url:`data:image/jpeg;base64,${converted.toString("base64")}`}}]}] };
  body.messages.push({role:"user",content:"QUALIFICATION_CASE:replay"});
  const replay = {stage:"history-replay",sourceCase:"large",currentCase:"replay"};
  const expected = {bytes,mimeType:"image/png",sha256:receipt.primaryImage.sha256,width:3200,height:1800,allowHostResize:true};
  const proof = await inspectProviderImage(body,expected,replay);
  assert.equal(proof.normalizedLandmarksPreserved,true);
  assert.deepEqual(proof.providerDimensions,{width:1200,height:675});
  assert.equal(proof.stage,"history-replay");
  assert.equal(proof.sourceCase,"large");
  assert.equal(proof.currentCase,"replay");
  assert.equal(proof.exactImageBytes,false);
  assert.equal(proof.frameSamples,100);
  assert.equal(proof.channelTolerance,4);
  assert.equal(proof.sourceImage.mimeType,"image/png");
  assert.equal(proof.providerImage.mimeType,"image/jpeg");
  assert.equal(proof.providerImage.byteLength,converted.length);
  assert.notEqual(proof.sourceImage.sha256,proof.providerImage.sha256);
  // An unrelated later turn must not contaminate the explicitly bounded source.
  const unrelated = { role:"user",content:"QUALIFICATION_CASE:unrelated" };
  const withUnrelated = { messages:[...body.messages.slice(0,-1),unrelated,body.messages[2],body.messages.at(-1)] };
  assert.deepEqual(await inspectProviderImage(withUnrelated,expected,replay),proof);
  const wrongExtent = structuredClone(body);
  const summary = JSON.parse(wrongExtent.messages[1].content);
  summary.observationV1.coordinateReference.sourceExtent.width = 1200;
  wrongExtent.messages[1].content = JSON.stringify(summary);
  await assert.rejects(inspectProviderImage(wrongExtent,expected,replay));
  // Center crop to 60% of each source dimension, then resize: quadrant centers
  // alone falsely accept this changed coordinate frame.
  const cropped = Buffer.alloc(raw.length);
  for (let y=0;y<675;y++) for(let x=0;x<1200;x++) {
    const sx=Math.floor(240+x*.6), sy=Math.floor(135+y*.6);
    raw.copy(cropped,(y*1200+x)*4,(sy*1200+sx)*4,(sy*1200+sx+1)*4);
  }
  body.messages.at(-2).content[0].image_url.url=`data:image/jpeg;base64,${jpeg.encode({width:1200,height:675,data:cropped},85).data.toString("base64")}`;
  await assert.rejects(inspectProviderImage(body,expected,replay));
  const mirrored = Buffer.alloc(raw.length);
  for (let y=0;y<675;y++) for(let x=0;x<1200;x++) raw.copy(mirrored,(y*1200+x)*4,(y*1200+1199-x)*4,(y*1200+1200-x)*4);
  const bad = jpeg.encode({width:1200,height:675,data:mirrored},85).data;
  body.messages.at(-2).content[0].image_url.url=`data:image/jpeg;base64,${bad.toString("base64")}`;
  await assert.rejects(inspectProviderImage(body,expected,replay));
});

async function largeSource() {
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(new URL("../contracts/v1/fixtures/images/geometry-3200x1800.png", import.meta.url));
  const receipt = JSON.parse(await readFile(new URL("../contracts/v1/fixtures/observations/valid-png.json", import.meta.url)));
  const dimensions = { width: 3200, height: 1800 };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  Object.assign(receipt.primaryImage, { byteLength: bytes.length, sha256, sourceDimensions: dimensions, deliveredDimensions: dimensions });
  receipt.coordinateReference.sourceExtent = { x: 0, y: 0, ...dimensions };
  return { expected: { bytes, mimeType: "image/png", sha256, ...dimensions, allowHostResize: true }, messages: [
    { role: "user", content: "QUALIFICATION_CASE:large" },
    { role: "tool", content: JSON.stringify({ observationV1: receipt }) },
    { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } }] },
  ] };
}

test("fresh large provider image requires exact original PNG and reports no decoded samples", async () => {
  const { expected, messages } = await largeSource();
  const proof = await inspectProviderImage({ messages }, expected, { currentCase: "large" });
  assert.equal(proof.exactImageBytes, true);
  assert.equal(proof.hostResize, false);
  assert.equal(proof.frameSamples, undefined);
  assert.deepEqual(proof.sourceImage, proof.providerImage);
  assert.deepEqual(proof.providerImage.dimensions, { width: 3200, height: 1800 });
  messages.at(-1).content[0].image_url.url = "data:image/jpeg;base64,d3Jvbmc=";
  await assert.rejects(inspectProviderImage({ messages }, expected, { currentCase: "large" }));
});

test("explicit replay rejects missing, ambiguous, wrong-turn and unrelated images", async () => {
  const { expected, messages } = await largeSource();
  const replay = { stage: "history-replay", sourceCase: "large", currentCase: "replay" };
  const marker = name => ({ role: "user", content: `QUALIFICATION_CASE:${name}` });
  const image = messages.at(-1);
  // The only image is in a later unrelated turn: an unbounded historical scan would accept it.
  await assert.rejects(inspectProviderImage({ messages: [messages[0], messages[1], marker("unrelated"), image, marker("replay")] }, expected, replay), /one image/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("large"), marker("replay")] }, expected, replay), /unique/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay")] }, expected, { ...replay, sourceCase: "missing" }), /unique/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay")] }, expected, { ...replay, sourceCase: "replay" }), /prior/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay"), image] }, expected), /observation/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, image, marker("replay")] }, expected, replay), /one image/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay")] }, expected, replay), /JPEG/);
  await assert.rejects(inspectProviderImage({ messages: [...messages, marker("replay-extra")] }, expected, replay), /current/);
});

// Discovery transport is qualified independently of the image assertions above.
const capabilitiesFixture = await import("./gateway-capabilities-fixture.mjs");
const discoveryBody = (text, id = "call_current", action = "health") => ({ messages: [
  { role: "user", content: "QUALIFICATION_CASE:old" },
  { role: "tool", tool_call_id: "call_old", content: "old private decoy" },
  { role: "user", content: "QUALIFICATION_CASE:current" },
  { role: "assistant", tool_calls: [{ id, function: { name: "computer_use", arguments: JSON.stringify({ action }) } }] },
  { role: "tool", tool_call_id: id, content: text },
] });
const discoveryOptions = { currentCase: "current", calls: [{ toolCallId: "call_current", action: "health" }] };

test("discovery provider receipts identify complete JSON and explicit host truncation without saving content", () => {
  assert.equal(typeof capabilitiesFixture.inspectDiscoveryTransport, "function");
  const full = capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success","action":"health"}'), discoveryOptions);
  assert.equal(full[0].fullCapabilityJsonTransport, true);
  const clipped = capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success"\n\n[... 50000 more characters truncated]'), discoveryOptions);
  assert.equal(clipped[0].truncated, true);
  assert.equal(clipped[0].stage, "provider-current-turn");
  assert.equal(clipped[0].sha256.length, 64);
  assert.equal(clipped[0].providerTextBudget, 32768);
  assert.equal(clipped[0].truncationStyle, "context-tail");
  assert.equal(JSON.stringify(clipped).includes("private"), false);
});

test("newer discovery live head-tail truncation remains current-call bound and obeys its exact 16000 character cap", () => {
  const middle = capabilitiesFixture.DISCOVERY_TRUNCATION_MARKER;
  const text = `{"status":"success"\n\n${middle}\n\n"tail":true}[... 11945 more characters truncated; rerun with narrower args if needed]`;
  const options = { ...discoveryOptions, hostVersion: "2026.11.3" };
  const proof = capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text), options)[0];
  assert.equal(proof.truncated, true);
  assert.equal(proof.fullCapabilityJsonTransport, false);
  assert.equal(proof.providerTextBudget, 16000);
  assert.equal(proof.truncationStyle, "live-middle");
  assert.equal(proof.hostVersion, "2026.11.3");
  for (const invalid of [text.replace("; rerun with narrower args if needed", ""), text.replace("11945", "0"), text.replace("args if needed", "different suffix"), text + "extra", text.replace(middle, middle + middle), "x".repeat(16001) + text]) {
    assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(invalid), options));
  }
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text), discoveryOptions));
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text), { ...options, currentCase: "stale" }));
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody("x".repeat(1000) + text), { ...options, contextWindowTokens: 1024 }));
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text), { ...options, hostVersion: "unknown" }));
  const longText = "x".repeat(11800) + text;
  const transport = capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(longText), options)[0];
  const message = { role: "toolResult", toolCallId: "call_current", content: [{ type: "text", text: longText.slice(0, 8000) }], __openclaw: { runId: "current-run", truncated: true, reason: "display-cap" } };
  const historyOptions = { toolCallId: "call_current", hostVersion: "2026.11.3", runId: "current-run", transport };
  const history = capabilitiesFixture.inspectDiscoveryHistory(message, historyOptions);
  assert.equal(history.truncated, true);
  assert.equal(history.stage, "chat-history-display");
  assert.equal(history.historyTextBudget, 8000);
  for (const patch of [{ toolCallId: "old" }, { __openclaw: { ...message.__openclaw, runId: "old" } }, { __openclaw: undefined }, { __openclaw: { ...message.__openclaw, reason: "unknown" } }, { content: [{ type: "text", text: "y".repeat(8000) }] }, { content: [{ type: "text", text: "x".repeat(8001) }] }]) {
    assert.throws(() => capabilitiesFixture.inspectDiscoveryHistory({ ...message, ...patch }, historyOptions));
  }
  assert.throws(() => capabilitiesFixture.inspectDiscoveryHistory(message, { ...historyOptions, transport: { ...transport, toolCallId: "old" } }));
  assert.throws(() => capabilitiesFixture.inspectDiscoveryHistory(message, { ...historyOptions, transport: undefined }));
});

test("discovery provider receipts reject wrong turns, missing or duplicate call ids and oversized live text", () => {
  const inspect = capabilitiesFixture.inspectDiscoveryTransport;
  assert.equal(typeof inspect, "function");
  assert.throws(() => inspect(discoveryBody('{}'), { ...discoveryOptions, currentCase: "old" }), /current turn/);
  assert.throws(() => inspect(discoveryBody('{"status":"success"}'), { ...discoveryOptions, currentCase: "curr" }), /current turn/);
  assert.throws(() => inspect(discoveryBody('{"status":"success"}', ""), { ...discoveryOptions, calls: [{ toolCallId: "", action: "health" }] }), /identity/);
  assert.throws(() => inspect(discoveryBody('{}', "call_wrong"), discoveryOptions), /tool call/);
  const duplicate = discoveryBody('{"status":"success"}'); duplicate.messages.push(duplicate.messages.at(-1));
  assert.throws(() => inspect(duplicate, discoveryOptions), /tool call/);
  assert.throws(() => inspect(discoveryBody("x".repeat(32769)), discoveryOptions), /limit/);
});

test("discovery provider receipts reject malformed complete JSON and never reconstruct clipped JSON", () => {
  const inspect = capabilitiesFixture.inspectDiscoveryTransport;
  assert.equal(typeof inspect, "function");
  assert.throws(() => inspect(discoveryBody("private invalid output"), discoveryOptions), /JSON/);
  assert.throws(() => inspect(discoveryBody('{"status":"invented"}'), discoveryOptions), /status/);
  assert.throws(() => inspect(discoveryBody('{"status":"success"}'), { ...discoveryOptions, calls: [{ toolCallId: "call_current", action: "file-write" }] }), /discovery/);
});

test("discovery replay correlation rejects missing evidence and action, status or scope mismatches", () => {
  const correlate = capabilitiesFixture.correlateDiscoveryReplay;
  assert.equal(typeof correlate, "function");
  const input = { transport: { stage: "provider-current-turn", truncated: true, toolCallId: "call", action: "permissions" }, history: { stage: "persisted-history", truncated: true, toolCallId: "call" }, call: { toolCallId: "call", action: "permissions" }, scope: { agentId: "agent", sessionKey: "session", auditPath: "/scratch/audit" }, auditRecords: [{ toolCallId: "call", action: "doctor", agentId: "agent", sessionKey: "session", result: { status: "error", success: false } }], replay: { status: 200, body: { result: { details: { action: "doctor", status: "error", success: false, evidence: { agentId: "agent", sessionKey: "session" } } } } } };
  assert.equal(correlate(input).status, "error");
  for (const mutate of [
    v => { v.history.truncated = false; },
    v => { v.transport = undefined; },
    v => { v.history.toolCallId = "wrong"; },
    v => { v.transport.toolCallId = "wrong"; },
    v => { v.transport.action = "health"; },
    v => { v.auditRecords = []; },
    v => { v.auditRecords.push(v.auditRecords[0]); },
    v => { v.auditRecords[0].action = "health"; },
    v => { v.auditRecords[0].sessionKey = "wrong"; },
    v => { v.auditRecords[0].agentId = "wrong"; },
    v => { v.replay.body.result.details.status = "success"; },
    v => { v.replay.body.result.details.action = "health"; },
    v => { v.replay.body.result.details.evidence.sessionKey = "wrong"; },
  ]) { const bad = structuredClone(input); mutate(bad); assert.throws(() => correlate(bad)); }
});

test("discovery provider proof rejects a missing legacy notice without trusting a separate replay", () => {
  const options = { ...discoveryOptions, calls: [{ ...discoveryOptions.calls[0], notices: ["fixed legacy notice"] }] };
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success"}'), options), /notice/);
  assert.equal(capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success","deprecation":"fixed legacy notice"}'), options).length, 1);
});

test("newer display replay requires its run, wire prefix and original scoped audit", () => {
  const prefix = { textChars: 8000, sha256: "a".repeat(64) };
  const input = { transport: { stage: "provider-current-turn", hostVersion: "2026.11.3", truncated: true, toolCallId: "call", action: "health", displayPrefix: prefix }, history: { stage: "chat-history-display", hostVersion: "2026.11.3", truncated: true, toolCallId: "call", runId: "current", ...prefix }, call: { toolCallId: "call", action: "health" }, scope: { runId: "current", agentId: "agent", sessionKey: "session", auditPath: "/scratch/audit" }, auditRecords: [{ toolCallId: "call", action: "health", agentId: "agent", sessionKey: "session", result: { status: "success", success: true } }], replay: { status: 200, body: { result: { details: { action: "health", status: "success", success: true, auditLog: "/scratch/audit" } } } } };
  assert.equal(capabilitiesFixture.correlateDiscoveryReplay(input).status, "success");
  for (const mutate of [
    v => { delete v.history.runId; delete v.scope.runId; },
    v => { v.scope.runId = "old"; },
    v => { v.history.sha256 = "b".repeat(64); },
    v => { v.transport.displayPrefix.textChars = 7999; },
    v => { v.auditRecords[0].sessionKey = "other"; },
    v => { v.replay.body.result.details.auditLog = "/other"; },
  ]) { const bad = structuredClone(input); mutate(bad); assert.throws(() => capabilitiesFixture.correlateDiscoveryReplay(bad)); }
});


test("discovery history proof enforces its own16k limit and exact persisted marker", () => {
  const inspect = capabilitiesFixture.inspectDiscoveryHistory;
  assert.equal(typeof inspect,"function");
  const message={role:"toolResult",toolCallId:"call",content:[{type:"text",text:'{"status":"success"\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n"tail":true}[... 100 more characters truncated]'}]};
  const result=inspect(message,{toolCallId:"call"});assert.equal(result.truncated,true);assert.equal(result.historyTextBudget,16000);assert.equal(result.stage,"persisted-history");
  assert.throws(()=>inspect(message,{toolCallId:"wrong"}),/identity/);
  assert.throws(()=>inspect({...message,content:[{type:"text",text:"x".repeat(16001)}]},{toolCallId:"call"}),/limit/);
  assert.throws(()=>inspect({...message,content:[{type:"text",text:"bad JSON"}]},{toolCallId:"call"}),/JSON/);
});

test("provider guard clipping can omit a legacy notice without claiming it was delivered", () => {
  const options={...discoveryOptions,calls:[{...discoveryOptions.calls[0],notices:["legacy notice"]}]};
  const proof=capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success"[... 100 more characters truncated]'),options)[0];
  assert.deepEqual(proof.legacyNotices,[{index:0,state:"unverified"}]);
  assert.throws(()=>capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success"\n⚠️ [... middle content omitted — showing head and tail ...]'),options),/provider|JSON/);
});

test("provider discovery budget is derived from the actual fixture context rather than the history cap", () => {
  const text="x".repeat(20000)+"[... 100 more characters truncated]";
  assert.equal(capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text),{...discoveryOptions,contextWindowTokens:65536})[0].providerTextBudget,32768);
  assert.throws(()=>capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text),{...discoveryOptions,contextWindowTokens:32768}),/limit/);
  assert.throws(()=>capabilitiesFixture.inspectDiscoveryTransport(discoveryBody(text),{...discoveryOptions,contextWindowTokens:NaN}),/budget/);
});


test("Stop-only discovery selection excludes host-denied health, doctor and permissions before JSON inspection", () => {
  const calls = ["health", "doctor", "permissions"].map(action => ({ action, toolCallId: `call_denied_${action}` }));
  const body = { messages: [
    { role: "user", content: "QUALIFICATION_CASE:current" },
    { role: "assistant", tool_calls: calls.map(call => ({ id: call.toolCallId, function: { name: "computer_use", arguments: JSON.stringify({ action: call.action }) } })) },
    ...calls.map(call => ({ role: "tool", tool_call_id: call.toolCallId, content: `Validation failed for tool computer_use: action ${call.action} is disabled by the trusted action permissions` })),
    { role: "tool", tool_call_id: "call_stop", content: '{"status":"success","action":"stop"}' },
  ] };
  // The old all-discovery selection reproduces the actual restricted-matrix failure.
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(body, { currentCase: "current", calls }), /Malformed untruncated discovery JSON/);
  const selected = capabilitiesFixture.selectEligibleDiscoveryCalls(calls, { allowedActions: ["stop"], canonicalAliases: { permissions: "doctor" } });
  assert.deepEqual(selected, []);
  assert.deepEqual(capabilitiesFixture.inspectDiscoveryTransport(body, { currentCase: "current", calls: selected }), []);
  assert.equal(JSON.parse(body.messages.at(-1).content).status, "success");
  for (const message of body.messages.slice(1, -1).filter(message => message.role === "tool")) assert.match(message.content, /Validation failed.*disabled by the trusted/);
});

test("trusted discovery selection preserves full, observation and desktop call identities and notices", () => {
  const calls = ["health", "doctor", "permissions", "stop", "file-read", "see"].map(action => ({ action, toolCallId: `call_${action}`, notices: action === "permissions" ? ["permissions is deprecated; use doctor instead."] : [] }));
  const canonicalAliases = { permissions: "doctor", see: "inspect" };
  const profiles = {
    full: ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "shell", "file-list", "file-read", "file-write", "clipboard-read", "clipboard-write", "browser-open", "app-launch"],
    "observation-only": ["health", "stop", "doctor", "inspect", "screenshot", "file-list", "file-read"],
    "desktop-only": ["health", "stop", "doctor", "inspect", "screenshot", "click", "type-text", "keypress", "scroll", "focus", "clipboard-read", "clipboard-write", "browser-open", "app-launch"],
  };
  for (const allowedActions of Object.values(profiles)) {
    const selected = capabilitiesFixture.selectEligibleDiscoveryCalls(calls, { allowedActions, canonicalAliases });
    assert.deepEqual(selected, calls.slice(0, 3));
    for (let index = 0; index < 3; index++) assert.equal(selected[index], calls[index]);
  }
  assert.deepEqual(capabilitiesFixture.selectEligibleDiscoveryCalls(calls, { allowedActions: ["health", "permissions"], canonicalAliases }), [calls[0]]);
});

test("eligible discovery still rejects malformed permitted JSON and response text cannot grant eligibility", () => {
  const call = { action: "permissions", toolCallId: "call_current" };
  const canonicalAliases = { permissions: "doctor" };
  const selected = capabilitiesFixture.selectEligibleDiscoveryCalls([call], { allowedActions: ["doctor"], canonicalAliases });
  assert.deepEqual(selected, [call]);
  assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(discoveryBody("Validation failed for tool computer_use", "call_current", "permissions"), { currentCase: "current", calls: selected }), /Malformed untruncated discovery JSON/);
  const denied = capabilitiesFixture.selectEligibleDiscoveryCalls([call], { allowedActions: ["stop"], canonicalAliases });
  assert.deepEqual(capabilitiesFixture.inspectDiscoveryTransport(discoveryBody('{"status":"success","action":"doctor","allowedActions":["doctor"]}'), { currentCase: "current", calls: denied }), []);
});


const discoveryPlanOptions = {
  currentCase: "current", allowedActions: ["health", "doctor", "stop"], canonicalAliases: { permissions: "doctor" },
  batchCallId: name => ({ legacy: "calllegacy", health: "callhealth" })[name],
  legacyToolName: "desktop_use", canonicalToolName: "computer_use",
};

test("caller discovery metadata safely excludes argument-free image replay and non-discovery plans", () => {
  const replayPlan = { args: undefined, imageKind: "large", replaySourceCase: "synthetic-image-large" };
  assert.deepEqual(capabilitiesFixture.discoveryCallsForPlan(replayPlan, discoveryPlanOptions), []);
  for (const args of [undefined, null, {}, { action: "screenshot" }, { action: "stop" }]) {
    assert.deepEqual(capabilitiesFixture.discoveryCallsForPlan({ args }, discoveryPlanOptions), []);
  }
  assert.deepEqual(capabilitiesFixture.discoveryCallsForPlan({ calls: [
    { name: "no-args" }, { name: "empty", args: {} }, { name: "image", args: { action: "screenshot" } },
  ] }, discoveryPlanOptions), []);
});

test("caller discovery metadata retains trusted eligibility, call IDs and canonical and legacy notices", () => {
  const build = capabilitiesFixture.discoveryCallsForPlan;
  assert.deepEqual(build({ args: { action: "health" }, tool: "computer_use" }, discoveryPlanOptions), [
    { action: "health", toolCallId: "call_current", notices: [] },
  ]);
  assert.deepEqual(build({ args: { action: "permissions" }, tool: "desktop_use" }, discoveryPlanOptions), [
    { action: "permissions", toolCallId: "call_current", notices: ["permissions is deprecated; use doctor instead.", "desktop_use is deprecated; use computer_use instead."] },
  ]);
  const batch = { tool: "desktop_use", calls: [
    { name: "no-args" }, { name: "legacy", args: { action: "permissions" } }, { name: "health", args: { action: "health" } },
  ] };
  assert.deepEqual(build(batch, discoveryPlanOptions), [
    { action: "permissions", toolCallId: "calllegacy", notices: ["permissions is deprecated; use doctor instead.", "desktop_use is deprecated; use computer_use instead."] },
    { action: "health", toolCallId: "callhealth", notices: ["desktop_use is deprecated; use computer_use instead."] },
  ]);
  assert.deepEqual(build(batch, { ...discoveryPlanOptions, allowedActions: ["stop"] }), []);
  assert.deepEqual(build({ args: { action: "permissions" } }, { ...discoveryPlanOptions, allowedActions: ["permissions"] }), []);
});

test("discovery proof binds current declarations and results across newer host inserted user-role messages", () => {
  const body = { messages: [
    { role: "user", content: "QUALIFICATION_CASE:current" },
    { role: "user", content: "fixture host-generated context before tool execution" },
    { role: "assistant", tool_calls: [{ id: "call_current", function: { name: "computer_use", arguments: '{"action":"health"}' } }] },
    { role: "tool", tool_call_id: "call_current", content: '{"status":"success","action":"health"}' },
    { role: "user", content: "fixture host-generated context after tool execution" },
  ] };
  assert.equal(capabilitiesFixture.inspectDiscoveryTransport(body, discoveryOptions)[0].fullCapabilityJsonTransport, true);
  for (const mutate of [
    value => value.messages.push({ role: "user", content: "QUALIFICATION_CASE:later" }),
    value => value.messages.push({ role: "user", content: "QUALIFICATION_CASE:current" }),
    value => value.messages.unshift(structuredClone(value.messages[2])),
    value => value.messages.unshift(structuredClone(value.messages[3])),
    value => { value.messages[2].tool_calls[0].function.arguments = '{"action":"doctor"}'; },
    value => { value.messages[2].tool_calls[0].function.name = "desktop_use"; },
    value => { [value.messages[2], value.messages[3]] = [value.messages[3], value.messages[2]]; },
    value => value.messages.splice(2, 1),
    value => { const declaration = value.messages.splice(2, 1)[0]; value.messages.unshift(declaration); },
  ]) {
    const changed = structuredClone(body); mutate(changed);
    assert.throws(() => capabilitiesFixture.inspectDiscoveryTransport(changed, discoveryOptions));
  }
});
