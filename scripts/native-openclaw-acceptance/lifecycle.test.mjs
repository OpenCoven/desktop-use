import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cancellationScope, observeOwnedGateway, stopOwnedGateway } from './lifecycle.mjs';
test('expiry aborts a pending operation before it can continue', async()=>{
  const scope=cancellationScope(Date.now()+20);
  try { await assert.rejects(Promise.race([scope.wait(new Promise(()=>{})),new Promise(resolve=>setTimeout(resolve,100))])); }
  finally { scope.dispose(); }
});

test('cancellation drains pending setup before cleanup and prevents later resource creation', async () => {
  const scope = cancellationScope(Date.now() + 5_000);
  let release, resource, spawned = false, cleaned = false;
  const delayed = new Promise(resolve => { release = resolve; });
  const work = scope.wait((async () => {
    await scope.setup(async () => { await delayed; resource = { closed: false }; });
    scope.check(); spawned = true;
  })());
  try {
    await Promise.resolve(); scope.abort(); await assert.rejects(work);
    const cleanup = (async () => {
      await scope.settleSetup();
      if (resource) resource.closed = true;
      cleaned = true;
    })();
    await Promise.resolve();
    assert.equal(cleaned, false, 'cleanup must wait for its pending acquisition');
    release(); await cleanup;
    assert.equal(resource.closed, true);
    assert.equal(spawned, false);
  } finally { release(); scope.dispose(); }
});

test('an exited leader without retained identities cannot certify descendant cleanup', async () => {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await once(child, 'exit');
  const result = await stopOwnedGateway(child, { graceMs: 50, killMs: 50 });
  assert.equal(result.allReaped, false, 'missing ownership evidence must fail closed after leader exit');
});

test('retained identities reap a detached descendant even after its leader exits', { timeout: 10_000 }, async () => {
  const code = `const{spawn}=require('node:child_process');process.once('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid)});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore','pipe','ignore','ipc'] });
  const observer = observeOwnedGateway(child, { intervalMs: 10 });
  let descendant;
  try {
    const ready = once(child.stdout, 'data'); child.send('spawn');
    const [bytes] = await ready; descendant = Number(String(bytes).trim());
    await new Promise(resolve => setTimeout(resolve, 100));
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
    const { known, inspectionFailed } = observer.stop();
    assert.equal(inspectionFailed, false); assert.ok(known.some(item => item.pid === descendant));
    const result = await stopOwnedGateway(child, { known, graceMs: 500, killMs: 1_000 });
    assert.equal(result.trackedProcessesGone, true);
    assert.equal(result.allReaped, false, 'unexpected leader exit must retain incomplete ownership status');
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  } finally {
    observer.stop();
    for (const pid of [child.pid,descendant]) if (pid) { try { process.kill(-pid,'SIGKILL'); } catch {} }
  }
});
test('SIGTERM runs bounded cleanup for the owned gateway and a detached descendant', {timeout:15_000}, async()=>{
  const moduleURL=new URL('./lifecycle.mjs',import.meta.url).href;
  const grandchildCode='setInterval(()=>{},1000)';
  const gatewayCode=`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{detached:true,stdio:'ignore'});console.log(JSON.stringify({descendant:child.pid}));setInterval(()=>{},1000);`;
  const workerCode=`import{spawn}from'node:child_process';import{cancellationScope,stopOwnedGateway}from${JSON.stringify(moduleURL)};const scope=cancellationScope(Date.now()+10000);const child=spawn(process.execPath,['-e',${JSON.stringify(gatewayCode)}],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.on('data',bytes=>console.log(JSON.stringify({gateway:child.pid,...JSON.parse(String(bytes))})));try{await scope.wait(new Promise(()=>{}))}catch{}finally{const result=await stopOwnedGateway(child,{graceMs:500,killMs:1000});console.log(JSON.stringify({cleanup:result}));scope.dispose();}`;
  const worker=spawn(process.execPath,['--input-type=module','-e',workerCode],{stdio:['ignore','pipe','pipe']});
  let output='',errors='',gateway,descendant;
  worker.stdout.on('data',bytes=>{output+=bytes;for(const line of output.trim().split('\n')){try{const value=JSON.parse(line);gateway??=value.gateway;descendant??=value.descendant;}catch{}}});
  worker.stderr.on('data',bytes=>{errors+=bytes;});
  try {
    const readyEnd=Date.now()+5000;while(!descendant&&Date.now()<readyEnd)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(descendant,errors); const ended=once(worker,'exit');worker.kill('SIGTERM');await ended;
    const cleanup=output.trim().split('\n').map(line=>JSON.parse(line)).find(value=>value.cleanup)?.cleanup;
    assert.equal(cleanup?.allReaped,true,'signal cancellation must reap the owned gateway and detached descendant');
  } finally {
    worker.kill('SIGKILL');for(const pid of [gateway,descendant])if(pid){try{process.kill(-pid,'SIGKILL')}catch{}}
  }
});
