// Explicitly executed by wayland-operator.py inside a disposable prepared consumer.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync,lstatSync,openSync,closeSync,readSync,fstatSync,constants } from 'node:fs';
import { createHash,randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { captureOwnedWaylandSnapshot } from './wayland-owned-snapshot.mjs';
import { proveWaylandCapture } from './wayland-scope-proof.mjs';
import { validateWaylandRun,waylandLease,proveWaylandUnavailable } from './wayland-run-contract.mjs';

assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--execute-owned-descriptor');
const config=JSON.parse(readFileSync(process.argv[3],'utf8'));
const require=createRequire(import.meta.url),packageRoot=dirname(require.resolve('@opencoven/openclaw-desktop-use/package.json'));
validateWaylandRun(config,{packageRoot,workerPath:fileURLToPath(new URL('./wayland-peer-observer.py',import.meta.url)),platform:process.platform,uid:process.getuid(),environment:process.env});
const remaining=waylandLease(config.leaseExpiresAt),sha=value=>createHash('sha256').update(value).digest('hex');
for(const binding of config.fileBindings) {
  const info=lstatSync(binding.path);assert.ok(info.isFile() && !info.isSymbolicLink() && info.size<=64*1024*1024);
  const descriptor=openSync(binding.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const opened=fstatSync(descriptor);assert.equal(opened.dev,info.dev);assert.equal(opened.ino,info.ino);
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0,count;
    while((count=readSync(descriptor,buffer,0,buffer.length,null))>0) {total+=count;assert.ok(total<=64*1024*1024);hash.update(buffer.subarray(0,count));remaining();}
    assert.equal(hash.digest('hex'),binding.sha256,'prepared source or artifact bytes changed');
  } finally {closeSync(descriptor);}
}
const {createDesktopClient,resolveActionPermissions}=await import('@opencoven/openclaw-desktop-use/sdk');
const {Client}=await import('@modelcontextprotocol/client');
const {StdioClientTransport}=await import('@modelcontextprotocol/client/stdio');
const {createJsonSchemaValidator}=await import(pathToFileURL(join(packageRoot,'dist/src/mcp/schema.js')));
const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'))),receipts=[];
const state=()=>{
  const info=lstatSync(config.fixtureStatePath);assert.ok(info.isFile() && !info.isSymbolicLink() && info.size<=1024*1024);
  const value=JSON.parse(readFileSync(config.fixtureStatePath));assert.equal(value.pid,config.fixturePid);assert.equal(value.ready,true);return value;
};
const snapshot=()=>{remaining();const value=captureOwnedWaylandSnapshot(config);assert.equal(value.output.scale,config.scale);return value;};
const save=(name,value)=>writeFileSync(join(config.runRoot,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
async function observed(predicate) {
  const end=performance.now()+Math.min(3000,remaining());
  while(performance.now()<end) {remaining();const value=state();if(predicate(value))return value;await pause();}
  throw new Error('FIXTURE_EFFECT_NOT_OBSERVED');
}
function controls(value) {return {clicks:value.clicks,text:value.text,keys:value.keys,scrollOffset:value.scrollOffset,entryFocused:value.entryFocused};}

for(const surface of ['sdk','mcp-modern','mcp-legacy']) {
  remaining();snapshot();const workspace=join(config.runRoot,surface+'-workspace'),privateState=join(config.runRoot,surface+'-state');
  mkdirSync(workspace,{mode:0o700});mkdirSync(privateState,{mode:0o700});const audit=[];let invoke,close=async()=>{};
  if(surface==='sdk') {
    const client=createDesktopClient({workspaceDir:workspace,scope:{principalId:'owned-wayland-acceptance',sessionId:surface},adapterPath:config.adapterPath,actionPermissions:resolveActionPermissions({actionProfile:'full'}),approvalProvider:()=> 'allowed',auditSink:async event=>audit.push(event)});
    invoke=(request,id)=>client.execute(request,{callId:id});
  } else {
    const hostConfig=join(config.runRoot,surface+'-config.json');
    writeFileSync(hostConfig,JSON.stringify({workspaceDir:workspace,stateDir:privateState,principalId:'owned-wayland-acceptance',sessionId:surface,adapterPath:config.adapterPath,actionProfile:'full'}),{mode:0o600,flag:'wx'});
    const modern=surface==='mcp-modern';
    const client=new Client({name:'owned-wayland-acceptance',version:'1'},{jsonSchemaValidator:createJsonSchemaValidator(),...(modern?{versionNegotiation:{mode:{pin:'2026-07-28'}}}:{supportedProtocolVersions:['2025-11-25']})});
    const env={};for(const key of ['PATH','HOME','XDG_RUNTIME_DIR','WAYLAND_DISPLAY','SWAYSOCK','XDG_SESSION_TYPE','XDG_CURRENT_DESKTOP','NATIVE_OWNED_DISPOSABLE_DISPLAY','LANG'])if(process.env[key])env[key]=process.env[key];
    const transport=new StdioClientTransport({command:config.fixtureExecutablePath,args:[config.ptyHostPath,'allow',process.execPath,join(packageRoot,'dist/examples/approval-host/main.js'),'--config',hostConfig],stderr:'pipe',env});
    // The real reference host's terminal prompts can contain task-local input.
    transport.stderr?.on('data',()=>{});
    try {await client.connect(transport);assert.equal(client.getServerVersion().version,manifest.version);assert.equal(client.getNegotiatedProtocolVersion(),modern?'2026-07-28':'2025-11-25');assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['computer_use']);} catch(error) {await client.close();throw error;}
    invoke=async request=>{const value=await client.callTool({name:'computer_use',arguments:request});return {content:value.content,details:value.structuredContent};};close=()=>client.close();
  }
  const cases=[];let sequence=0;
  async function call(request,{success=true}={}) {
    const timeoutMs=Math.floor(Math.min(15_000,remaining()));
    const result=await invoke({...request,timeoutMs},surface+'-'+(++sequence));
    assert.equal(result.details.success,success,surface+'/'+request.action+' failed its expected outcome');return result;
  }
  try {
    const health=await call({action:'health'},{success:false}),caps=health.details.capabilitiesV1;
    assert.equal(caps.schemaVersion,1);assert.equal(caps.actions.screenshot.state,'available');assert.equal(caps.actions['type-text'].state,'available');assert.equal(caps.actions.click.state,'unsupported');
    cases.push({action:'health',overallReady:false,screenshot:caps.actions.screenshot.state,typing:caps.actions['type-text'].state,click:caps.actions.click.state});
    await call({action:'focus',windowTitle:config.fixtureTitle});
    let decodedTarget;
    for(const format of ['png','jpg']) {
      const before=snapshot(),capture=await call({action:'screenshot',mode:'screen',format}),after=snapshot();
      const images=capture.content.filter(item=>item.type==='image');assert.equal(images.length,1);
      const bytes=Buffer.from(images[0].data,'base64'),receipt=capture.details.observationV1;
      assert.equal(sha(bytes),receipt.primaryImage.sha256);assert.equal(bytes.length,receipt.primaryImage.byteLength);
      const imagePath=join(config.runRoot,surface+'-actual.'+format),fixture={...state(),origin:[before.windowRect.x,before.windowRect.y]},proofState=join(config.runRoot,surface+'-'+format+'-geometry-private.json');
      writeFileSync(imagePath,bytes,{mode:0o600,flag:'wx'});save(surface+'-'+format+'-geometry-private.json',fixture);
      const decoded=spawnSync(config.fixtureExecutablePath,[config.imageProofPath,imagePath,proofState,JSON.stringify(receipt)],{encoding:'utf8',timeout:Math.floor(Math.min(15_000,remaining())),killSignal:'SIGKILL',maxBuffer:131072});
      assert.equal(decoded.status,0,'actual image decoder failed');
      const pixelProof=JSON.parse(decoded.stdout);assert.equal(pixelProof.actualReceivedPixelsVerified,true);assert.equal(pixelProof.landmarks.length,4);assert.equal(pixelProof.clientResize.mappingPreserved,true);
      const scopeProof=proveWaylandCapture({before,after,receipt,fixture,format,imageMimeType:images[0].mimeType,decodedDimensions:pixelProof.decodedDimensions,decodedMimeType:pixelProof.decodedMimeType});
      if(format==='png')decodedTarget=pixelProof.desktopPoint;
      cases.push({action:'screenshot',mode:'screen',mimeType:images[0].mimeType,sha256:receipt.primaryImage.sha256,byteLength:bytes.length,geometry:receipt.geometry,pixelProof,scopeProof});
    }
    snapshot();const initial=state();assert.equal(initial.entryFocused,true);
    const marker='owned-'+randomBytes(10).toString('hex');await call({action:'type-text',text:marker});
    const typed=await observed(value=>value.text===initial.text+marker);assert.equal(typed.text.length-initial.text.length,marker.length);
    cases.push({action:'type-text',actualEditableChange:true,charactersAdded:marker.length});
    snapshot();const keyBefore=state();assert.equal(keyBefore.entryFocused,true);await call({action:'keypress',keys:['a']});
    const keyed=await observed(value=>value.keys.length>keyBefore.keys.length && value.text===keyBefore.text+'a');
    assert.equal(keyed.keys.length,keyBefore.keys.length+1);cases.push({action:'keypress',actualKeyCallback:true,actualEditableChange:true});
    assert.ok(Array.isArray(decodedTarget) && decodedTarget.length===2 && decodedTarget.every(Number.isFinite));
    for(const request of [{action:'screenshot',mode:'frontmost',format:'png'},{action:'click',coords:decodedTarget.map(Math.round).join(',')}]) {
      snapshot();const before=controls(state()),result=await call(request,{success:false});
      const end=performance.now()+250;let noEffect;
      do {remaining();noEffect=proveWaylandUnavailable({request,result,before,after:controls(state())});await pause();} while(performance.now()<end);
      snapshot();proveWaylandUnavailable({request,result,before,after:controls(state())});
      cases.push({action:request.action,mode:request.mode??null,status:result.details.status,...noEffect,noEffectObservationMs:250,...(request.action==='click'?{pixelDerivedDesktopPoint:decodedTarget}:{})});
    }
    const auditText=surface==='sdk'?JSON.stringify(audit):readFileSync(join(privateState,'audit.jsonl'),'utf8');
    assert.equal(auditText.includes(marker),false);assert.doesNotMatch(auditText,/"(?:nonce|mac|approvalId|screenshot_raw)"|base64/);
    const row={surface,success:true,decisionSource:surface==='sdk'?'scripted-trusted-host':'scripted-operator-through-actual-terminal-broker',cases};receipts.push(row);save(surface+'-receipt.json',row);
  } finally {await close();}
}
save('receipt.json',{schemaVersion:1,success:true,sourceCommit:config.sourceCommit,sourceTree:config.sourceTree,harnessCommit:config.harnessCommit,harnessTree:config.harnessTree,harnessSources:config.harnessSources,nativeSha256:sha(readFileSync(config.adapterPath)),packageArchiveSha256:sha(readFileSync(config.packageArchivePath)),packageVersion:manifest.version,scale:config.scale,session:'owned-headless-native-Wayland-Sway-1.7',physicalDisplayVerified:false,activeCancellationQualified:false,officialProviderQualified:false,receipts});
console.log(JSON.stringify({success:true,scale:config.scale,surfaces:receipts.map(row=>row.surface)}));
