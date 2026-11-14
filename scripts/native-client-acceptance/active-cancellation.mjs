// ONLY the task-owned Linux graphics container. The outer Python guard resumes Xvfb even on failure.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
assert.equal(process.platform, 'linux'); assert.equal(process.env.NATIVE_OWNED_DISPOSABLE_DISPLAY, 'yes');
const server = Number((await readFile('/owned/xvfb.pid','utf8')).trim());
const command = (await readFile(`/proc/${server}/cmdline`)).toString().split('\0');
assert.ok(server>1 && command[0].endsWith('Xvfb') && command[1]===':91');
const packageRoot = dirname(createRequire(import.meta.url).resolve('@opencoven/openclaw-desktop-use/package.json'));
const state = async () => JSON.parse(await readFile('/owned/fixture-client-state.json'));
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function descendants(pid) {
  let children;
  try { children = (await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
  return [...children,...(await Promise.all(children.map(descendants))).flat()];
}
async function activeHelper(name, timeout=8000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    for(const pid of await descendants(process.pid)) {
      try { if((await readFile(`/proc/${pid}/comm`,'utf8')).trim()===name) return pid; } catch {}
    }
    await delay(10);
  }
  throw new Error(`Actual ${name} helper was not observed in flight`);
}
async function connect(surface,label) {
  const workspace=`/owned/active-${surface}-${label}`; await mkdir(workspace,{mode:0o700});
  const options={workspaceDir:workspace,scope:{principalId:'native-active',sessionId:label},adapterPath:'/owned/source/target/debug/coven-desktop-use',actionPermissions:resolveActionPermissions({actionProfile:'full'}),auditSink:async()=>{},approvalProvider:()=> 'allowed'};
  if(surface==='sdk') {
    const client=createDesktopClient(options);
    return {call:(r,signal)=>client.execute(r,{callId:label+'-'+r.action,signal}),close:async()=>{},workspace};
  }
  const privateState=join(workspace,'state');await mkdir(privateState,{mode:0o700});
  const config=join(workspace,'config.json');await writeFile(config,JSON.stringify({workspaceDir:workspace,stateDir:privateState,principalId:'native-active',sessionId:label,adapterPath:options.adapterPath,actionProfile:'full'}),{mode:0o600});
  const {createJsonSchemaValidator}=await import(pathToFileURL(join(packageRoot,'dist/src/mcp/schema.js')));
  const modern=surface==='mcp-modern';
  const client=new Client({name:'active-native-acceptance',version:'1'},{jsonSchemaValidator:createJsonSchemaValidator(),...(modern?{versionNegotiation:{mode:{pin:'2026-07-28'}}}:{supportedProtocolVersions:['2025-11-25']})});
  const transport=new StdioClientTransport({command:'python3',args:['/owned/pty-host.py','allow',process.execPath,join(packageRoot,'dist/examples/approval-host/main.js'),'--config',config],stderr:'pipe',env:{PATH:process.env.PATH,DISPLAY:':91',XDG_SESSION_TYPE:'x11'}});
  transport.stderr?.on('data',()=>{});await client.connect(transport);
  return {call:async(r,signal)=>{const x=await client.callTool({name:'computer_use',arguments:r},{signal});return{content:x.content,details:x.structuredContent};},close:()=>client.close(),workspace};
}
const cases=[],failures=[];
try {
  for(const surface of ['sdk','mcp-modern','mcp-legacy']) {
    for(const mode of ['stop','timeout',...(surface==='sdk'?['abort']:[])]) {
      const instance=await connect(surface,'capture-'+mode);
      const destination=join(instance.workspace,'preserved.png');await writeFile(destination,'owned-original');
      const abort=new AbortController();let stopped=false;
      try {
        process.kill(server,'SIGSTOP');stopped=true;
        const pending=instance.call({action:'screenshot',mode:'screen',path:destination,timeoutMs:mode==='timeout'?5000:10000},abort.signal);
        const helper=await activeHelper('scrot');
        if(mode==='stop') assert.equal((await instance.call({action:'stop'})).details.success,true);
        if(mode==='abort') abort.abort();
        const result=await pending;
        assert.equal(result.details.status,mode==='timeout'?'timeout':'cancelled');
        assert.equal(result.content.some(c=>c.type==='image'),false);
        assert.equal(await readFile(destination,'utf8'),'owned-original');
        await assert.rejects(access(`/proc/${helper}`));
        process.kill(server,'SIGCONT');stopped=false;
        await delay(250);assert.equal(await readFile(destination,'utf8'),'owned-original');
        cases.push({surface,case:'active-capture-'+mode,status:result.details.status,actualHelper:'scrot',helperReaped:true,destinationPreserved:true,noLatePublication:true});
      } catch(error) {
        failures.push({surface,case:'active-capture-'+mode,failure:String(error.message)});
      } finally {if(stopped)process.kill(server,'SIGCONT');await instance.close();}
    }
    const instance=await connect(surface,'input-stop');
    const inputAbort=new AbortController();let inputPending;
    try {
      const expectedPid=Number((await readFile('/owned/client-fixture.pid','utf8')).trim());
      const fixture=await state();
      assert.ok(fixture.ready && fixture.pid===expectedPid && expectedPid>1,'matching owned fixture must be ready');
      assert.equal((await instance.call({action:'focus',windowTitle:'DesktopuseInstalledClient'})).details.success,true);
      assert.equal((await state()).pid,expectedPid,'fixture identity must remain stable after focus');
      const before=(await state()).keys.length;
      const pending=instance.call({action:'type-text',text:'a'.repeat(600),timeoutMs:10000},inputAbort.signal);
      inputPending=pending;pending.catch(()=>{});
      const helper=await activeHelper('xdotool');
      const end=Date.now()+3000;
      while((await state()).keys.length===before && Date.now()<end)await delay(10);
      assert.ok((await state()).keys.length>before,'actual input must begin before Stop');
      await instance.call({action:'stop'});
      const result=await pending;assert.equal(result.details.status,'cancelled');
      await assert.rejects(access(`/proc/${helper}`));
      const settled=(await state()).keys.length;await delay(750);
      assert.equal((await state()).keys.length,settled,'input cannot continue after Stop settles');
      cases.push({surface,case:'active-input-stop',status:result.details.status,actualHelper:'xdotool',helperReaped:true,observedPartialInput: true,noLateInput:true,completedKeyCount:settled-before});
    } catch(error) {
      failures.push({surface,case:'active-input-stop',failure:String(error.message)});
    } finally {inputAbort.abort();if(inputPending)await inputPending.catch(()=>{});await instance.close();}
  }
  await writeFile('/owned/active-native-receipt.json',JSON.stringify({success:failures.length===0,session:'virtual-x11',physicalDisplayVerified:false,cases,failures},null,2)+'\n');
  console.log(JSON.stringify({success:failures.length===0,cases:cases.length,failures}));
  if(failures.length)process.exitCode=1;
} catch(error) {
  await writeFile('/owned/active-native-partial.json',JSON.stringify({success:false,cases,failure:String(error.message)},null,2)+'\n');
  throw error;
} finally {process.kill(server,'SIGCONT');}
