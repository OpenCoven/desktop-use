const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

if (process.argv[2] !== 'type-text') {
  process.stdout.write('{"ok":false,"code":"FIXTURE_UNSUPPORTED"}\n');
} else {
  const root = __dirname;
  let directory, operationId = null, child, forceTimer;
  let stopping = false, ready = false, finished = false, childFailed = false, auditFailed = false, stateFailed = false;
  const event = (name, extra = {}) => {
    if (operationId === null) { auditFailed = true; return; }
    try { fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ schemaVersion: 1, operationId, event: name, role: 'adapter', pid: process.pid, ...extra }) + '\n', { mode: 0o600 }); }
    catch { auditFailed = true; }
  };
  const marker = (name, value) => {
    const temporary = path.join(directory, `${name}.tmp-${process.pid}`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, operationId, parentPid: process.pid, ...value }) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, path.join(directory, name));
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  };
  const finish = status => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    const effectCommitted = !!directory && fs.existsSync(path.join(directory, 'effect.txt'));
    if (stateFailed || auditFailed) status = 'error';
    event('adapter-terminal', { status, effectCommitted });
    if (auditFailed) status = 'error';
    const terminal = { status, helperPid: child?.pid ?? null, effectCommitted, helperReaped: true, auditWritten: !auditFailed };
    if (directory) {
      try { marker('terminal.json', terminal); }
      catch { stateFailed = true; terminal.status = 'error'; }
    }
    const code = stateFailed ? 'FIXTURE_STATE_FAILED' : auditFailed ? 'FIXTURE_AUDIT_FAILED' : status === 'cancelled' ? 'CANCELLED' : 'FIXTURE_ERROR';
    process.exitCode = stateFailed || auditFailed ? 1 : 0;
    process.stdout.write(JSON.stringify({ ok: terminal.status === 'success', ...(terminal.status === 'success' ? {} : { code }), fixture: { operationId, ...terminal } }) + '\n');
  };
  const stopChild = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null || forceTimer) return;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 200);
    forceTimer.unref();
  };
  const failState = () => {
    stateFailed = true;
    event('state-failed');
    if (child) stopChild(); else finish('error');
  };
  const cancel = () => {
    if (finished || stopping) return;
    stopping = true;
    event('cancel-requested');
    stopChild();
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    directory = fs.mkdtempSync(path.join(root, 'operations', 'op-'));
    operationId = path.basename(directory);
    marker('started.json', {});
    event('adapter-started');
    child = fork(path.join(root, 'helper.cjs'), [directory], { cwd: root, execArgv: [], detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('error', () => { childFailed = true; });
    child.on('message', message => {
      if (message?.event !== 'ready' || ready || finished) return;
      ready = true;
      if (stopping || stateFailed) { stopChild(); return; }
      try {
        marker('active.json', { helperPid: child.pid });
        event('adapter-active', { helperPid: child.pid });
      } catch { failState(); }
    });
    child.once('close', code => finish(stopping || code === 2 ? 'cancelled' : !childFailed && code === 0 && fs.existsSync(path.join(directory, 'effect.txt')) ? 'success' : 'error'));
  } catch { failState(); }
}
