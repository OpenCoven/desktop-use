const phases = new Set(['fixture-precondition','request-method','request-json','case-marker','tool-inventory','tool-results','wire-image-proof','gateway-spawn','gateway-readiness','rpc-connect','session-create','effective-tools','agent-start','approval-request','agent-completion','audit-proof']);
const classes = new Set(['AssertionError','Error','TypeError','SyntaxError','RangeError']);
const codes = new Set(['NATIVE21_CONDITION_TIMEOUT','NATIVE21_RPC_TIMEOUT','NATIVE21_CONNECT_TIMEOUT','NATIVE21_RPC_REJECTED','NATIVE21_CANCELLED']);

export function safeFailure(error, phase) {
  const result = { phase: phases.has(phase) ? phase : 'unknown', errorClass: classes.has(error?.name) ? error.name : 'OtherError', code: codes.has(error?.message) ? error.message : 'WITHHELD' };
  const site = typeof error?.stack === 'string' && error.stack.match(/\/(run|wire-proof|fixture-lease|linux-fixture-read)\.mjs:(\d{1,6}):(\d{1,6})(?:\)|\s|$)/);
  if (site) Object.assign(result, { module: site[1], line: Number(site[2]), column: Number(site[3]) });
  return result;
}
