const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const directory = process.argv[2];
if (!directory || path.dirname(directory) !== path.join(root, 'operations') || !/^op-[A-Za-z0-9]+$/.test(path.basename(directory))) process.exit(1);
const operationId = path.basename(directory);
let holdAfterEffect;
try {
  const options = JSON.parse(fs.readFileSync(path.join(root, 'fixture-options.json'), 'utf8'));
  if (options.schemaVersion !== 1 || typeof options.holdAfterEffect !== 'boolean') process.exit(1);
  holdAfterEffect = options.holdAfterEffect;
} catch { process.exit(1); }
let done = false, committed = false, timer;
const event = name => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ schemaVersion: 1, operationId, event: name, role: 'helper', pid: process.pid }) + '\n', { mode: 0o600 });
const end = (name, code) => {
  if (done) return;
  done = true;
  clearInterval(timer);
  try { event(name); }
  catch { code = 1; }
  process.exit(code);
};
// Exit 2 distinguishes an interrupted hold from successful completion even if the adapter received no signal.
process.on('SIGTERM', () => end('helper-cancelled', 2));
process.on('SIGINT', () => end('helper-cancelled', 2));
process.on('disconnect', () => end('helper-disconnected', 2));
timer = setInterval(() => {
  try {
    if (!committed && fs.existsSync(path.join(directory, 'release'))) {
      fs.writeFileSync(path.join(directory, 'effect.txt'), 'fixture-effect\n', { mode: 0o600, flag: 'wx' });
      committed = true;
      event('effect-committed');
      if (holdAfterEffect) event('helper-after-effect');
    }
    if (committed && (!holdAfterEffect || fs.existsSync(path.join(directory, 'finish')))) end('helper-finished', 0);
  } catch { end('helper-error', 1); }
}, 10);
event('helper-ready');
process.send?.({ event: 'ready' });
