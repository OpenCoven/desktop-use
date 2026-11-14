// Synthetic discovery envelopes only; this wrapper never performs desktop input.
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
export async function createCapabilitiesFixture(repo, root, fallbackAdapter) {
  const marker = join(root, "capability-envelope.json");
  const adapter = join(root, "capability-adapter.cjs");
  const parked = `${adapter}.parked`;
  await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='doctor'&&fs.existsSync(${JSON.stringify(marker)})){process.stdout.write(fs.readFileSync(${JSON.stringify(marker)}));process.exit(0);}const child=cp.spawnSync(${JSON.stringify(fallbackAdapter)},args,{encoding:'utf8',env:process.env});process.stdout.write(child.stdout||'');process.exit(child.status??1);\n`, { mode: 0o700 });
  return { adapter, marker,
    async select(name) {
      if (name === "missing-adapter") { await rename(adapter, parked); return; }
      const { report } = JSON.parse(await readFile(join(repo, `contracts/v1/fixtures/capabilities/${name === "schema-unknown" ? "x11" : name}.json`), "utf8"));
      if (name === "schema-unknown") report.schemaVersion = 99;
      await writeFile(marker, JSON.stringify({ ok: name !== "missing-helper", ...(name === "missing-helper" ? { code: "ENOENT" } : {}), platform: report.environment.platform, session: report.environment.session, capabilitiesV1: report, ...(name === "x11-empty" ? { setupGuide: { missingTools: ["scrot", "xdotool", "wmctrl"], installCommand: "sudo apt install scrot xdotool wmctrl" } } : {}) }), { mode: 0o600 });
    },
    async restore() { await rename(parked, adapter).catch(error => { if (error.code !== "ENOENT") throw error; }); await rm(marker, { force: true }); },
  };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export const DISCOVERY_TRUNCATION_MARKER = "⚠️ [... middle content omitted — showing head and tail ...]";
export const QUALIFICATION_CONTEXT_TOKENS = 65536;
const contextTail = text => /\[\.\.\. [1-9]\d* more characters truncated\]$/.test(text);
const newerContextTail = text => /\[\.\.\. [1-9]\d* more characters truncated; rerun with narrower args if needed\]$/.test(text);
const textContent = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
const discoveryActions = new Set(["health", "doctor", "permissions"]);
export function selectEligibleDiscoveryCalls(calls, { allowedActions, canonicalAliases }) {
  return calls.filter(call => discoveryActions.has(call.action) && allowedActions.includes(canonicalAliases[call.action] ?? call.action));
}
export function discoveryCallsForPlan(plan, { currentCase, batchCallId, allowedActions, canonicalAliases, legacyToolName, canonicalToolName }) {
  return selectEligibleDiscoveryCalls((plan.calls ?? [{ name: currentCase, args: plan.args }]).map(call => ({ action: call.args?.action, toolCallId: plan.calls ? batchCallId(call.name) : `call_${currentCase}`, notices: [...(call.args?.action === "permissions" ? ["permissions is deprecated; use doctor instead."] : []), ...(plan.tool === legacyToolName ? [`${legacyToolName} is deprecated; use ${canonicalToolName} instead.`] : [])] })), { allowedActions, canonicalAliases });
}
const normalizedCallId = value => typeof value === "string" ? value.replace(/[^a-zA-Z0-9]/g, "") : "";
export function inspectDiscoveryTransport(body, { currentCase, calls, contextWindowTokens = QUALIFICATION_CONTEXT_TOKENS, toolName = "computer_use", hostVersion = "2026.4.26" }) {
  assert.ok(Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0, "Unknown provider context budget");
  assert.ok(["2026.4.26", "2026.11.3"].includes(hostVersion), "Unknown discovery host");
  const newerHost = hostVersion === "2026.11.3";
  // Exact pinned guard: contextTokens*2*.5 estimated chars, then estimate/text ratio2.
  const contextBudget = Math.floor(Math.max(1024, Math.floor(contextWindowTokens * 2 * .5)) / 2);
  const liveCap = contextWindowTokens >= 200000 ? 64000 : contextWindowTokens >= 100000 ? 32000 : 16000;
  const providerTextBudget = newerHost ? Math.min(contextBudget, Math.floor(contextWindowTokens * .3) * 4, liveCap) : contextBudget;
  const messages = body.messages ?? [];
  // Harness-authored turns carry unique markers. Newer hosts may add unmarked
  // user-role context; require the real call declaration and result as well.
  const marked = messages.flatMap((message, index) => message.role === "user"
    ? [...textContent(message.content).matchAll(/QUALIFICATION_CASE:([a-z0-9-]+)/g)].map(match => ({ name: match[1], index })) : []);
  const current = marked.filter(marker => marker.name === currentCase);
  assert.ok(current.length === 1 && marked.at(-1)?.name === currentCase, "Discovery proof must use the unique current turn");
  const markerIndex = current[0].index;
  assert.ok(calls.every(call => normalizedCallId(call.toolCallId).length > 0), "Missing expected tool identity");
  assert.equal(new Set(calls.map(call => normalizedCallId(call.toolCallId))).size, calls.length, "Ambiguous expected tool call");
  return calls.map(call => {
    assert.ok(discoveryActions.has(call.action), "Only discovery may use this transport proof");
    const declarations = messages.flatMap((message, index) => message.role === "assistant"
      ? (message.tool_calls ?? []).filter(item => normalizedCallId(item.id) === normalizedCallId(call.toolCallId)).map(item => ({ item, index })) : []);
    assert.ok(declarations.length === 1 && declarations[0].index > markerIndex, "Missing, replayed or ambiguous current-turn tool call declaration");
    assert.ok(["computer_use", "desktop_use"].includes(toolName), "Unknown expected discovery tool name");
    assert.equal(declarations[0].item.function?.name, toolName, "Current-turn tool call name mismatch");
    let argumentsValue;
    try { argumentsValue = JSON.parse(declarations[0].item.function.arguments); } catch { assert.fail("Malformed discovery tool call arguments"); }
    assert.equal(argumentsValue.action, call.action, "Current-turn tool call action mismatch");
    const matching = messages.flatMap((message, index) => message.role === "tool" && normalizedCallId(message.tool_call_id) === normalizedCallId(call.toolCallId) ? [{ message, index }] : []);
    assert.ok(matching.length === 1 && matching[0].index > declarations[0].index, "Missing, replayed, unordered or ambiguous current-turn tool call result");
    const content = matching[0].message.content;
    const text = textContent(content);
    assert.ok(text.length > 0 && text.length <= providerTextBudget, "Discovery provider text exceeds the context guard limit");
    const middle = text.includes(DISCOVERY_TRUNCATION_MARKER);
    const truncated = newerHost ? newerContextTail(text) : contextTail(text);
    if (newerHost && middle) {
      assert.ok(truncated, "Newer live middle omission requires its exact context suffix");
      assert.equal(text.split(DISCOVERY_TRUNCATION_MARKER).length, 2, "Ambiguous live omission marker");
      const parts = text.split(`\n\n${DISCOVERY_TRUNCATION_MARKER}\n\n`);
      assert.ok(parts.length === 2 && parts.every(part => part.length > 0), "Malformed live head-tail omission");
    } else assert.ok(!middle, "Unexpected persisted-history marker in current provider result");
    const legacyNotices = (call.notices ?? []).map((notice, index) => ({ index, state: text.includes(notice) ? "observed" : "unverified" }));
    if (!truncated) assert.ok(legacyNotices.every(notice => notice.state === "observed"), "Discovery deprecation notice is absent from complete provider wire");
    if (!truncated) {
      let complete;
      try { complete = JSON.parse(text); } catch { assert.fail("Malformed untruncated discovery JSON"); }
      assert.ok(["success", "error", "unsupported", "needsApproval", "timeout", "cancelled"].includes(complete.status), "Invalid complete discovery status");
    }
    return { action: call.action, toolCallId: call.toolCallId, stage: "provider-current-turn", hostVersion, textChars: text.length, sha256: createHash("sha256").update(text).digest("hex"), contextWindowTokens, providerTextBudget, truncationStyle: truncated ? middle ? "live-middle" : "context-tail" : "none", legacyNotices, truncated, fullCapabilityJsonTransport: !truncated, ...(newerHost && text.length > 8000 ? { displayPrefix: { textChars: 8000, sha256: createHash("sha256").update(text.slice(0, 8000)).digest("hex") } } : {}) };
  });
}

export function inspectDiscoveryHistory(message, { toolCallId, hostVersion = "2026.4.26", runId, transport }) {
  assert.ok(message?.role === "toolResult" && message.toolCallId === toolCallId, "History tool identity mismatch");
  const text = textContent(message.content);
  if (hostVersion === "2026.11.3") {
    assert.ok(typeof runId === "string" && runId.length > 0 && message.__openclaw?.runId === runId, "History display run identity mismatch");
    assert.ok(text.length > 0 && text.length <= 8000, "Discovery display history exceeds the pinned limit");
    const truncated = message.__openclaw.truncated === true;
    const sha256 = createHash("sha256").update(text).digest("hex");
    if (truncated) {
      assert.equal(message.__openclaw.reason, "display-cap");
      assert.equal(text.length, 8000);
      assert.ok(transport?.stage === "provider-current-turn" && transport.hostVersion === hostVersion && transport.toolCallId === toolCallId, "Display history requires same-call live transport");
      assert.deepEqual(transport.displayPrefix, { textChars: text.length, sha256 }, "Display history must match the verified live prefix");
    } else { try { JSON.parse(text); } catch { assert.fail("Malformed complete display history JSON"); } }
    return { stage: "chat-history-display", hostVersion, runId, toolCallId, textChars: text.length, sha256, historyTextBudget: 8000, truncationStyle: truncated ? "display-prefix" : "none", truncated };
  }
  assert.equal(hostVersion, "2026.4.26", "Unknown discovery history host");
  assert.ok(text.length > 0 && text.length <= 16000, "Discovery history text exceeds the persisted limit");
  const truncated = text.includes(DISCOVERY_TRUNCATION_MARKER) && contextTail(text);
  if (!truncated) { try { JSON.parse(text); } catch { assert.fail("Malformed untruncated history JSON"); } }
  return { stage: "persisted-history", toolCallId, textChars: text.length, sha256: createHash("sha256").update(text).digest("hex"), historyTextBudget: 16000, truncationStyle: truncated ? "persisted-middle" : "none", truncated };
}

export function correlateDiscoveryReplay({ transport, history, auditRecords, call, replay, scope }) {
  assert.ok(discoveryActions.has(call.action) && transport?.stage === "provider-current-turn" && (transport.truncated === true || transport.fullCapabilityJsonTransport === true), "Discovery replay requires verified provider transport");
  assert.ok(["persisted-history", "chat-history-display"].includes(history?.stage) && history.truncated === true && history.toolCallId === call.toolCallId, "Discovery replay requires explicit same-call history truncation");
  if (history.stage === "chat-history-display") {
    assert.equal(transport.hostVersion, "2026.11.3");
    assert.equal(history.hostVersion, "2026.11.3");
    assert.ok(typeof history.runId === "string" && history.runId.length > 0, "Discovery replay requires a history run identity");
    assert.equal(history.runId, scope.runId, "Discovery replay history run mismatch");
    assert.deepEqual(transport.displayPrefix, { textChars: history.textChars, sha256: history.sha256 }, "Discovery replay display prefix mismatch");
  }
  assert.equal(transport.toolCallId, call.toolCallId, "Discovery tool identity mismatch");
  assert.equal(transport.action, call.action, "Discovery transport action mismatch");
  const matching = auditRecords.filter(record => record.toolCallId === call.toolCallId);
  assert.equal(matching.length, 1, "Missing or ambiguous discovery audit");
  const audit = matching[0];
  const canonical = call.action === "permissions" ? "doctor" : call.action;
  assert.equal(audit.action, canonical, "Discovery audit action mismatch");
  assert.equal(audit.agentId, scope.agentId, "Discovery audit agent scope mismatch");
  assert.equal(audit.sessionKey, scope.sessionKey, "Discovery audit session scope mismatch");
  assert.equal(replay.status, 200, "Structured discovery replay failed");
  const details = replay.body?.result?.details;
  assert.equal(details?.action, canonical, "Structured replay action mismatch");
  assert.equal(details?.status, audit.result.status, "Structured replay status mismatch");
  assert.equal(details?.success, audit.result.success, "Structured replay outcome mismatch");
  if (canonical === "doctor") {
    assert.equal(details.evidence?.agentId, scope.agentId, "Structured replay agent scope mismatch");
    assert.equal(details.evidence?.sessionKey, scope.sessionKey, "Structured replay session scope mismatch");
  } else assert.equal(details.auditLog, scope.auditPath, "Structured replay audit scope mismatch");
  return details;
}
