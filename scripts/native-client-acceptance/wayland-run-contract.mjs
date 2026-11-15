import assert from 'node:assert/strict';
import { isAbsolute, relative, sep } from 'node:path';

export function inside(root,path) {
  assert.ok(isAbsolute(root) && isAbsolute(path));
  const value=relative(root,path);
  return value!=='' && value!=='..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export function proveWaylandUnavailable({request,result,before,after}) {
  assert.equal(result.details.success,false);
  const native=result.details.result;
  assert.equal(native?.ok,false);
  let outcome;
  if(request.action==='screenshot' && request.mode==='frontmost') {
    assert.equal(result.details.status,'unsupported');assert.equal(native.supported,false);assert.equal(native.backend,'linux');
    outcome='unsupported-frontmost-capture';
  } else {
    assert.equal(request.action,'click');assert.equal(result.details.status,'error');assert.equal(native.supported,true);assert.equal(native.backend,'wayland-click');assert.equal(native.error,'Missing required tool: ydotool.');
    outcome='missing-pointer-helper';
  }
  assert.equal(result.content.filter(item=>item.type==='image').length,0);
  assert.equal(before.entryFocused,true);assert.equal(after.entryFocused,true);
  assert.deepEqual(after,before);
  return {outcome,unavailableNoEffect:true};
}

export function waylandLease(expiresAt,{epoch=Date.now,monotonic=()=>performance.now()}={}) {
  assert.match(expiresAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/);
  const end=Date.parse(expiresAt),started=monotonic(),budget=end-epoch();
  assert.ok(Number.isFinite(end) && budget>=60_000 && budget<=1_200_000,'a fresh bounded timezone-qualified lease is required');
  return function remaining(reserveMs=15_000) {
    const elapsed=monotonic()-started;
    assert.ok(Number.isFinite(elapsed) && elapsed>=0);
    const value=Math.min(end-epoch(),budget-elapsed)-reserveMs;
    assert.ok(value>0,'owned Wayland lease exhausted; cleanup reserve retained');
    return value;
  };
}

export function validateWaylandRun(config,{packageRoot,workerPath,platform,uid,environment}) {
  assert.equal(platform,'linux');assert.ok(Number.isSafeInteger(uid) && uid>0);
  assert.equal(environment.NATIVE_OWNED_DISPOSABLE_DISPLAY,'yes');assert.equal(environment.XDG_SESSION_TYPE,'wayland');
  assert.equal(config.schemaVersion,1);assert.match(config.sourceCommit,/^[a-f0-9]{40}$/);assert.match(config.sourceTree,/^[a-f0-9]{40}$/);
  assert.match(config.harnessCommit,/^[a-f0-9]{40}$/);assert.match(config.harnessTree,/^[a-f0-9]{40}$/);
  assert.ok(config.harnessSources && Object.keys(config.harnessSources).length>0);
  for(const [name,hash] of Object.entries(config.harnessSources)) {assert.ok(name.startsWith('scripts/') || name==='src/mcp/fixtures/pty-host.py');assert.match(hash,/^[a-f0-9]{64}$/);}
  assert.ok([1,2].includes(config.scale));assert.equal(config.peerObserverPath,workerPath);
  assert.equal(config.packageRoot,packageRoot);assert.ok(inside(config.consumerRoot,packageRoot));
  assert.ok(inside(config.consumerRoot,config.harnessRoot));
  assert.ok(inside(config.runRoot,config.fixtureStatePath));assert.ok(inside(config.runRoot,config.runtimeRoot));
  assert.equal(environment.XDG_RUNTIME_DIR,config.runtimeRoot);assert.equal(environment.SWAYSOCK,config.swaySocket);assert.equal(environment.WAYLAND_DISPLAY,config.waylandDisplay);
  assert.ok(Array.isArray(config.fileBindings) && config.fileBindings.length>0);
  const paths=new Set();
  for(const binding of config.fileBindings) {
    assert.ok(isAbsolute(binding.path) && !paths.has(binding.path));assert.match(binding.sha256,/^[a-f0-9]{64}$/);paths.add(binding.path);
  }
  for(const path of [config.adapterPath,config.packageArchivePath,config.peerObserverPath,config.fixtureSourcePath,config.swayConfigPath,config.imageProofPath,config.ptyHostPath])assert.ok(paths.has(path),'all executed sources and artifacts must be bound');
  assert.ok(config.fileBindings.some(item=>item.path===`${packageRoot}/package.json`));
  return true;
}
