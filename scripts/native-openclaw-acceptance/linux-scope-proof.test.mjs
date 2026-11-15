import assert from 'node:assert/strict';
import test from 'node:test';
import { captureX11ScopeSnapshot, parseX11Rectangle, proveCaptureScope, proveImageFormat } from './linux-scope-proof.mjs';

for(const format of ['png','jpg'])test(`requested ${format} agrees with wire, receipt and decoded bytes`,()=>{
 const mime=format==='png'?'image/png':'image/jpeg';
 assert.doesNotThrow(()=>proveImageFormat({requestedFormat:format,imageMimeType:mime,receiptMimeType:mime,decodedMimeType:mime}));
});
for(const field of ['imageMimeType','receiptMimeType','decodedMimeType'])test(`JPEG request rejects ${field} PNG substitution`,()=>{
 const x={requestedFormat:'jpg',imageMimeType:'image/jpeg',receiptMimeType:'image/jpeg',decodedMimeType:'image/jpeg'};x[field]='image/png';
 assert.throws(()=>proveImageFormat(x));
});
test('a consistently PNG result cannot satisfy a JPEG request',()=>{
 assert.throws(()=>proveImageFormat({requestedFormat:'jpg',imageMimeType:'image/png',receiptMimeType:'image/png',decodedMimeType:'image/png'}));
});

function example(mode = 'frontmost') {
  const window = { x:100, y:120, width:640, height:480 };
  const root = { x:0, y:0, width:1280, height:960 };
  const before = { pid:42, processStartTicks:'1234', windowId:4194307, window, root, startedAtMs:1000, finishedAtMs:1010, startedMonotonicMs:1000, finishedMonotonicMs:1010 };
  const after = { ...structuredClone(before), startedAtMs:1100, finishedAtMs:1110, startedMonotonicMs:1100, finishedMonotonicMs:1110 };
  const rect = mode === 'screen' ? root : window;
  const dimensions = { width:rect.width, height:rect.height };
  const receipt = { capturedAtMs:1050, requestedScope:{mode}, actualScope:{state:'available',mode}, primaryImage:{sourceDimensions:dimensions,deliveredDimensions:dimensions}, geometry:{state:'available',coordinateUnits:'desktop-physical-pixels',regions:[{imageRect:{x:0,y:0,...dimensions},desktopRect:rect}]} };
  const fixture = {pid:42,origin:[100,120],size:[640,480]};
  return {mode,before,after,receipt,fixture,decodedDimensions:dimensions};
}
for (const mode of ['screen','frontmost']) test(`exact independently bracketed ${mode} extent passes`,()=>{
  assert.equal(proveCaptureScope(example(mode)).independentExtentVerified,true);
});
for (const fault of ['broader-crop','origin','decoded-size','changed-window','changed-pid','changed-birth','changed-extent','stale-capture','long-bracket','unknown-scope','wrong-request','extra-region','wrong-units','fixture-origin']) test(`scope proof rejects ${fault}`,()=>{
  const x=example();
  if(fault==='broader-crop'){x.receipt.geometry.regions[0]={imageRect:{x:0,y:0,width:1280,height:960},desktopRect:x.before.root};x.receipt.primaryImage.sourceDimensions=x.receipt.primaryImage.deliveredDimensions=x.decodedDimensions={width:1280,height:960};}
  if(fault==='origin')x.receipt.geometry.regions[0].desktopRect={...x.before.window,x:0};
  if(fault==='decoded-size')x.decodedDimensions={width:1280,height:960};
  if(fault==='changed-window')x.after.windowId++;
  if(fault==='changed-pid')x.after.pid++;
  if(fault==='changed-birth')x.after.processStartTicks='1235';
  if(fault==='changed-extent')x.after.window.width++;
  if(fault==='stale-capture')x.receipt.capturedAtMs=900;
  if(fault==='long-bracket')x.after.finishedAtMs=50_000;
  if(fault==='unknown-scope')x.receipt.actualScope.state='unknown';
  if(fault==='wrong-request')x.receipt.requestedScope.mode='screen';
  if(fault==='extra-region')x.receipt.geometry.regions.push(x.receipt.geometry.regions[0]);
  if(fault==='wrong-units')x.receipt.geometry.coordinateUnits='points';
  if(fault==='fixture-origin')x.fixture.origin=[0,0];
  assert.throws(()=>proveCaptureScope(x));
});
for(const fault of ['hidden-long-capture','missing-clock','reversed-clock','nonfinite-clock'])test(`scope freshness rejects ${fault}`,()=>{
 const x=example();
 if(fault==='hidden-long-capture')x.after.finishedMonotonicMs=22_000;
 if(fault==='missing-clock')delete x.before.startedMonotonicMs;
 if(fault==='reversed-clock')x.after.startedMonotonicMs=900;
 if(fault==='nonfinite-clock')x.after.finishedMonotonicMs=Infinity;
 assert.throws(()=>proveCaptureScope(x));
});
const info='xwininfo: Window id: 0x400003 "DesktopuseInstalledClient"\n  Absolute upper-left X:  100\n  Absolute upper-left Y:  120\n  Width: 640\n  Height: 480\n  Border width: 0\n  Map State: IsViewable\n';
test('independent X11 parser binds exact window ID, extent and border',()=>{
  assert.deepEqual(parseX11Rectangle(info,4194307),{x:100,y:120,width:640,height:480});
});
for(const fault of ['foreign-window','border','unmapped','duplicate','fractional'])test(`X11 parser rejects ${fault}`,()=>{
 let text=info;
 if(fault==='foreign-window')text=text.replace('0x400003','0x400004');
 if(fault==='border')text=text.replace('Border width: 0','Border width: 1');
 if(fault==='unmapped')text=text.replace('IsViewable','IsUnMapped');
 if(fault==='duplicate')text+='  Width: 640\n';
 if(fault==='fractional')text=text.replace('Width: 640','Width: 640.5');
 assert.throws(()=>parseX11Rectangle(text,4194307));
});

function collector(fault) {
 let pidReads=0,birthReads=0,activeReads=0;
 const probes=[];
 const hooks={platform:'linux',now:()=>1000,monotonicNow:()=>1000,focused:async()=>example().fixture,environment:()=>({DISPLAY:':91'}),read:async()=>{
   const fields=['S',...Array(18).fill('0'),fault==='birth' && birthReads++ ? '1235':'1234'];
   if(fault==='zombie')fields[0]='Z';
   return `42 (fixture with ) spaces) ${fields.join(' ')}\n`;
 },execute:(program,args,options)=>{
   probes.push({program,args,options});
   if(fault==='command')return {status:1,stdout:''};
   if(program==='xdotool' && args[0]==='getactivewindow')return {status:0,stdout:String(fault==='focus' && activeReads++ ? 4194308:4194307)};
   if(program==='xdotool')return {status:0,stdout:String(fault==='pid' && pidReads++ ? 43:42)};
   return {status:0,stdout:args[0]==='-root'?info.replace('0x400003 "DesktopuseInstalledClient"','0x1 (the root window)').replace('X:  100','X:  0').replace('Y:  120','Y:  0').replace('Width: 640','Width: 1280').replace('Height: 480','Height: 960'):info};
 }};
 return {hooks,probes};
}
test('owned collector binds process birth around all bounded read-only geometry probes',async()=>{
 const {hooks,probes}=collector();const s=await captureX11ScopeSnapshot('/owned/state.json',hooks);
 assert.deepEqual(s,{...example().before,finishedAtMs:1000,startedMonotonicMs:1000,finishedMonotonicMs:1000});
 assert.equal(probes.length,6);assert.ok(probes.every(p=>p.options.timeout<=4000 && p.options.maxBuffer===32768));
 assert.ok(probes.every(p=>!p.args.some(a=>['windowactivate','windowfocus','click','type'].includes(a))));
});
for(const fault of ['birth','zombie','focus','pid','command'])test(`owned collector rejects ${fault} before returning a scope oracle`,async()=>{
 const {hooks}=collector(fault);await assert.rejects(captureX11ScopeSnapshot('/owned/state.json',hooks));
});
test('wall-clock rollback cannot enlarge the four-second subprocess budget',async()=>{
 const {hooks,probes}=collector();let reads=0;hooks.now=()=>reads++ ? -10_000:1000;
 await assert.rejects(captureX11ScopeSnapshot('/owned/state.json',hooks));
 assert.ok(probes.every(p=>p.options.timeout<=4000));
});
test('monotonic expiration rejects a collector even when wall time is frozen',async()=>{
 const {hooks}=collector();let reads=0;hooks.monotonicNow=()=>reads++ ? 5000:0;
 await assert.rejects(captureX11ScopeSnapshot('/owned/state.json',hooks));
});
