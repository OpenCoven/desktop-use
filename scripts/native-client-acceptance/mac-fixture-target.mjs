import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function assertMacFixtureTarget({ baseline, owner, fixture, observed }) {
  assert.match(baseline.fixtureBundleIdentifier ?? '', /^org\.opencoven\.desktopuse\.acceptance\.run-[a-z0-9-]{4,}$/);
  assert.equal(observed.bundleIdentifier, baseline.fixtureBundleIdentifier, 'fixture bundle differs from the trusted preparation');
  assert.equal(observed.infoPlistSha256, baseline.fixtureInfoPlistSha256, 'fixture bundle metadata changed');
  assert.equal(observed.fixtureBinarySha256, baseline.fixtureBinarySha256, 'fixture executable changed');
  assert.ok(fixture.ready && fixture.focused, 'new owned fixture must be ready and focused');
  assert.ok(Number.isSafeInteger(owner.windowNumber) && owner.windowNumber > 0);
  assert.equal(fixture.windowNumber, owner.windowNumber, 'fixture window changed');
  assert.equal(fixture.pid, owner.pid, 'fixture PID changed');
  assert.ok(observed.process, 'new owned fixture is no longer live');
  for (const field of ['pid', 'uid', 'birthSeconds', 'birthMicroseconds']) {
    assert.ok(Number.isSafeInteger(owner[field]), `invalid fixture ${field}`);
    assert.equal(observed.process[field], owner[field], `fixture ${field} changed`);
  }
  assert.ok(owner.pid > 1 && owner.uid >= 0 && owner.birthSeconds > 0 && owner.birthMicroseconds >= 0 && owner.birthMicroseconds < 1_000_000);
  assert.equal(owner.path, observed.expectedExecutable, 'owner must bind this prepared executable');
  assert.equal(observed.process.path, observed.expectedExecutable, 'PID belongs to a different fixture executable');
  return { app: baseline.fixtureBundleIdentifier, windowId: owner.windowNumber };
}

// Read-only libproc and bundle metadata; no desktop helper, app launch or input.
// The already ABI-qualified process module is hash-bound before Python loads it.
const probe = String.raw`
import hashlib, importlib.util, json, os, pathlib, plistlib, sys
root=pathlib.Path(sys.argv[1]).resolve(strict=True)
module=pathlib.Path(sys.argv[3]).resolve(strict=True)
spec=importlib.util.spec_from_file_location('owned_fixture_processes',module)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
table=m.DarwinProcessTable();before=table.info(int(sys.argv[2]))
contents=root/'DesktopUseAcceptance.app/Contents'
image=(contents/'MacOS/DesktopUseAcceptance').resolve(strict=True)
plist=(contents/'Info.plist').read_bytes()
assert len(plist)<=65536 and image.stat().st_size<=8*1024*1024
value={'process':before,'expectedExecutable':str(image),'bundleIdentifier':plistlib.loads(plist)['CFBundleIdentifier'],'infoPlistSha256':hashlib.sha256(plist).hexdigest(),'fixtureBinarySha256':hashlib.sha256(image.read_bytes()).hexdigest()}
after=table.info(int(sys.argv[2]))
identity=lambda p:None if p is None else tuple(p[k] for k in ['pid','uid','birthSeconds','birthMicroseconds','path'])
assert identity(before)==identity(after),'fixture process changed during metadata acquisition'
print(json.dumps(value))
`;

export async function preparedMacFixtureTarget(root, fixture, python = process.env.NATIVE_ACCEPTANCE_PYTHON) {
  assert.equal(process.platform, 'darwin');
  const baseline = JSON.parse(await readFile(join(root, 'baseline.json')));
  const module = join(root, 'consumer/mac_owned_processes.py');
  const expected = baseline.consumerScriptsSha256?.['mac_owned_processes.py'];
  assert.match(expected ?? '', /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(await readFile(module)).digest('hex'), expected, 'process inspection module changed');
  assert.equal(await realpath(module), join(await realpath(root), 'consumer/mac_owned_processes.py'));
  assert.ok(typeof python === 'string' && python.startsWith('/'), 'prepared Python path required');
  const child = spawnSync(python, ['-I', '-B', '-c', probe, root, String(fixture.pid), module], { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, 'read-only fixture process and bundle inspection failed');
  const observed = JSON.parse(child.stdout);
  const owner = JSON.parse(await readFile(join(root, 'fixture-owner.json')));
  return assertMacFixtureTarget({ baseline, owner, fixture, observed });
}
