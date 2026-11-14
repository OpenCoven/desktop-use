import { execFileSync } from 'node:child_process';

export function cancellationScope(expiresAt) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('NATIVE21_CANCELLED'));
  const handlers = ['SIGINT','SIGTERM'].map(signal => { process.on(signal, abort); return [signal, abort]; });
  const timer = setTimeout(abort, Math.max(0, expiresAt - Date.now()));
  function check() { if (Date.now() >= expiresAt) abort(); if (controller.signal.aborted) throw controller.signal.reason; }
  function wait(promise) {
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(controller.signal.reason);
      try { check(); } catch (error) { reject(error); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
  }
  return { check, wait, abort, dispose() { clearTimeout(timer); for (const [signal, handler] of handlers) process.removeListener(signal, handler); } };
}

function processes() {
  return String(execFileSync('ps', ['-axo','pid=,ppid=,pgid=,lstart='], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })).trim().split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), start: match[4].trim() }] : [];
  });
}
export function snapshotOwnedGateway(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return [];
  const all = processes(), owned = new Set([child.pid]);
  let added;
  do { added = false; for (const item of all) if (owned.has(item.ppid) && !owned.has(item.pid)) { owned.add(item.pid); added = true; } } while (added);
  return all.filter(item => owned.has(item.pid));
}
export async function stopOwnedGateway(child, { known = [], graceMs = 5_000, killMs = 2_000 } = {}) {
  if (!child?.pid) return { allReaped: true, trackedProcesses: 0 };
  const tracked = new Map([...known, ...snapshotOwnedGateway(child)].map(item => [item.pid, item]));
  const groups = new Set([child.pid, ...[...tracked.values()].map(item => item.group)]);
  const ours = processes().find(item => item.pid === process.pid)?.group;
  groups.delete(ours);
  const sameProcess = (current, original) => current.pid === original.pid && current.start === original.start;
  function signalOwned(signal) {
    const current = processes();
    for (const group of groups) {
      if (current.some(item => item.group === group && [...tracked.values()].some(original => sameProcess(item, original)))) {
        try { process.kill(-group, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
  function gone() {
    const current = processes();
    return !current.some(item => groups.has(item.group) || [...tracked.values()].some(original => sameProcess(item, original)));
  }
  async function waitForGone(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (gone()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
    return gone();
  }
  signalOwned('SIGTERM'); let allReaped = await waitForGone(graceMs);
  if (!allReaped) { signalOwned('SIGKILL'); allReaped = await waitForGone(killMs); }
  return { allReaped, trackedProcesses: tracked.size, trackedGroups: groups.size, detachedDescendantsChecked: true };
}
