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
const textContent = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
const discoveryActions = new Set(["health", "doctor", "permissions"]);
const normalizedCallId = value => typeof value === "string" ? value.replace(/[^a-zA-Z0-9]/g, "") : "";
export function inspectDiscoveryTransport(body, { currentCase, calls, contextWindowTokens = QUALIFICATION_CONTEXT_TOKENS }) {
  assert.ok(Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0, "Unknown provider context budget");
  // Exact pinned guard: contextTokens*2*.5 estimated chars, then estimate/text ratio2.
  const providerTextBudget = Math.floor(Math.max(1024, Math.floor(contextWindowTokens * 2 * .5)) / 2);
  const messages = body.messages ?? [];
  const lastUser = messages.findLastIndex(message => message.role === "user");
  assert.ok(lastUser >= 0 && JSON.stringify(messages[lastUser].content).match(/QUALIFICATION_CASE:([a-z0-9-]+)/)?.[1] === currentCase, "Discovery proof must use the current turn");
  const tools = messages.slice(lastUser + 1).filter(message => message.role === "tool");
  assert.ok(calls.every(call => normalizedCallId(call.toolCallId).length > 0), "Missing expected tool identity");
  assert.equal(new Set(calls.map(call => normalizedCallId(call.toolCallId))).size, calls.length, "Ambiguous expected tool call");
  return calls.map(call => {
    assert.ok(discoveryActions.has(call.action), "Only discovery may use this transport proof");
    const matching = tools.filter(message => normalizedCallId(message.tool_call_id) === normalizedCallId(call.toolCallId));
    assert.equal(matching.length, 1, "Missing or ambiguous current-turn tool call");
    const content = matching[0].content;
    const text = textContent(content);
    assert.ok(text.length > 0 && text.length <= providerTextBudget, "Discovery provider text exceeds the context guard limit");
    assert.ok(!text.includes(DISCOVERY_TRUNCATION_MARKER), "Unexpected persisted-history marker in current provider result");
    const truncated = contextTail(text);
    const legacyNotices = (call.notices ?? []).map((notice, index) => ({ index, state: text.includes(notice) ? "observed" : "unverified" }));
    if (!truncated) assert.ok(legacyNotices.every(notice => notice.state === "observed"), "Discovery deprecation notice is absent from complete provider wire");
    if (!truncated) {
      let complete;
      try { complete = JSON.parse(text); } catch { assert.fail("Malformed untruncated discovery JSON"); }
      assert.ok(["success", "error", "unsupported", "needsApproval", "timeout", "cancelled"].includes(complete.status), "Invalid complete discovery status");
    }
    return { action: call.action, toolCallId: call.toolCallId, stage: "provider-current-turn", textChars: text.length, sha256: createHash("sha256").update(text).digest("hex"), contextWindowTokens, providerTextBudget, truncationStyle: truncated ? "context-tail" : "none", legacyNotices, truncated, fullCapabilityJsonTransport: !truncated };
  });
}

export function inspectDiscoveryHistory(message, { toolCallId }) {
  assert.ok(message?.role === "toolResult" && message.toolCallId === toolCallId, "History tool identity mismatch");
  const text = textContent(message.content);
  assert.ok(text.length > 0 && text.length <= 16000, "Discovery history text exceeds the persisted limit");
  const truncated = text.includes(DISCOVERY_TRUNCATION_MARKER) && contextTail(text);
  if (!truncated) { try { JSON.parse(text); } catch { assert.fail("Malformed untruncated history JSON"); } }
  return { stage: "persisted-history", toolCallId, textChars: text.length, sha256: createHash("sha256").update(text).digest("hex"), historyTextBudget: 16000, truncationStyle: truncated ? "persisted-middle" : "none", truncated };
}

export function correlateDiscoveryReplay({ transport, history, auditRecords, call, replay, scope }) {
  assert.ok(discoveryActions.has(call.action) && transport?.stage === "provider-current-turn" && (transport.truncated === true || transport.fullCapabilityJsonTransport === true), "Discovery replay requires verified provider transport");
  assert.ok(history?.stage === "persisted-history" && history.truncated === true && history.toolCallId === call.toolCallId, "Discovery replay requires explicit same-call history truncation");
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
