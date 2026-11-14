// Copy into the isolated installed consumer. Real stdio/broker, fixture-only negative effects.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {verifyMacIdentity} from './identity-preflight.mjs';
const root=await realpath(process.env.NATIVE_ACCEPTANCE_ROOT),adapter=await realpath(process.env.NATIVE_ACCEPTANCE_ADAPTER);
if(process.platform==='darwin')await verifyMacIdentity(root,adapter);
const python=process.platform==='darwin'?await realpath(process.env.NATIVE_ACCEPTANCE_PYTHON):'python3';
const fixturePath=await realpath(process.env.NATIVE_ACCEPTANCE_FIXTURE_STATE),pty=await realpath(process.env.NATIVE_ACCEPTANCE_PTY);
const state=async()=>{const s=JSON.parse(await readFile(fixturePath));return {clicks:s.clicks,keys:s.keys,text:s.text,scrollOffset:s.scrollOffset};};
const initial=await state(),fixture=JSON.parse(await readFile(fixturePath));
const request={action:'keypress',keys:['a'],...(process.platform==='darwin'?{app:'org.opencoven.desktopuse.acceptance',windowId:fixture.windowNumber}:{})};
const packageRoot=dirname(createRequire(import.meta.url).resolve('@opencoven/openclaw-desktop-use/package.json'));
const {createJsonSchemaValidator}=await import(pathToFileURL(join(packageRoot,'dist/src/mcp/schema.js')));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));const results=[];const attempt=Date.now();
async function connect(era,mode){
 const dir=join(root,`negative-${attempt}-${era}-${mode}`);await mkdir(dir,{mode:0o700});
 const workspace=join(dir,'workspace'),stateDir=join(dir,'state');await mkdir(workspace,{mode:0o700});await mkdir(stateDir,{mode:0o700});
 const config=join(dir,'config.json');await writeFile(config,JSON.stringify({workspaceDir:workspace,stateDir,principalId:'native-negative',sessionId:era+'-'+mode,adapterPath:adapter,actionProfile:'full',approvalTimeoutMs:mode==='expiry'?100:300000}),{mode:0o600});
 const modern=era==='modern';const client=new Client({name:'native-negative',version:'1'},{jsonSchemaValidator:createJsonSchemaValidator(),...(modern?{versionNegotiation:{mode:{pin:'2026-07-28'}}}:{supportedProtocolVersions:['2025-11-25']})});
 const broker=mode!=='missing';const transport=new StdioClientTransport({command:broker?python:process.execPath,args:broker?[pty,mode==='denied'?'deny':'wait',process.execPath,join(packageRoot,'dist/examples/approval-host/main.js'),'--config',config]:[join(packageRoot,'dist/src/mcp/main.js'),'--config',config],stderr:'pipe',env:{PATH:process.env.PATH,TMPDIR:root}});
 let terminal='';transport.stderr?.on('data',c=>{terminal+=c;if(terminal.length>128*1024)terminal=terminal.slice(-128*1024);});
 try{await client.connect(transport);}catch(error){await client.close();throw error;}
 return{client,stateDir,terminal:()=>terminal,close:()=>client.close()};
}
for(const era of ['modern','legacy']){
 for(const mode of ['missing','denied','expiry','stop','abort']){
  const f=await connect(era,mode);
  try{
   if(mode==='missing'){
    const r=await f.client.callTool({name:'computer_use',arguments:request});assert.equal(r.structuredContent.status,'needsApproval');
    for(const forged of [{...request,confirm:true},{...request,workspaceDir:root}]){
     let refused=false;try{const r=await f.client.callTool({name:'computer_use',arguments:forged});refused=r.isError===true;}catch{refused=true;}assert.equal(refused,true);
    }
   }else if(mode==='denied'||mode==='expiry'){
    const r=await f.client.callTool({name:'computer_use',arguments:request});assert.equal(r.structuredContent.status,mode==='denied'?'blocked':'timeout');
   }else{
    const abort=new AbortController();const pending=f.client.callTool({name:'computer_use',arguments:request},{signal:abort.signal});pending.catch(()=>{});
    const end=Date.now()+10000;while(!f.terminal().includes('Decision [allow/deny/cancel]')&&Date.now()<end)await delay(10);
    assert.ok(f.terminal().includes('Decision [allow/deny/cancel]'),'actual operator prompt must be pending');
    if(mode==='stop'){
     await f.client.callTool({name:'computer_use',arguments:{action:'stop'}});assert.equal((await pending).structuredContent.status,'cancelled');
    }else{abort.abort();await assert.rejects(pending);}
    const auditEnd=Date.now()+3000;let cancelled=false;
    while(Date.now()<auditEnd){const lines=(await readFile(join(f.stateDir,'audit.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));if(lines.some(e=>e.result?.status==='cancelled')){cancelled=true;break;}await delay(10);}
    assert.equal(cancelled,true,'actual cancellation must reach the audit');
   }
   await delay(150);assert.deepEqual(await state(),initial,'negative broker case must not affect the fixture');
   const audit=await readFile(join(f.stateDir,'audit.jsonl'),'utf8');assert.doesNotMatch(audit,/"(?:nonce|mac|approvalId|screenshot_raw)"|base64/);
   results.push({protocol:era==='modern'?'2026-07-28':'2025-11-25',case:mode,noFixtureEffect:true,forgedAuthorityRejected:mode==='missing'});
  }finally{await f.close();}
 }
}
const receipt={success:true,surface:'installed-mcp',adapterSha256:createHash('sha256').update(await readFile(adapter)).digest('hex'),decisionSource:'scripted-operator-through-real-terminal-broker',cases:results,noFixtureEffect:true,humanAcceptance:false,publication:false};
await writeFile(join(root,'mcp-security-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({success:true,cases:results.length}));
