import assert from 'node:assert/strict';
import test from 'node:test';
import { proveWaylandCapture, normalizeWaylandSnapshot } from './wayland-scope-proof.mjs';

function example(scale=1) {
 const rect={x:0,y:0,width:1280/scale,height:960/scale};
 const before={fixturePid:42,fixtureStartTicks:'123',compositorPid:32,compositorStartTicks:'100',windowId:5,windowRect:rect,focused:true,output:{name:'HEADLESS-1',rect,physicalSize:{width:1280,height:960},scale,transform:'normal'},startedAtMs:1000,finishedAtMs:1010,startedMonotonicMs:10,finishedMonotonicMs:20};
 const after={...structuredClone(before),startedAtMs:1100,finishedAtMs:1110,startedMonotonicMs:110,finishedMonotonicMs:120};
 const dimensions={width:1280,height:960};
 const receipt={capturedAtMs:1050,requestedScope:{mode:'screen'},actualScope:{state:'available',mode:'screen'},primaryImage:{mimeType:'image/png',sourceDimensions:dimensions,deliveredDimensions:dimensions},geometry:{state:'available',coordinateUnits:'desktop-logical-pixels',regions:[{displayId:'HEADLESS-1',imageRect:{x:0,y:0,...dimensions},desktopRect:rect}]}};
 return {before,after,receipt,format:'png',imageMimeType:'image/png',decodedMimeType:'image/png',decodedDimensions:dimensions,fixture:{pid:42,origin:[0,0],size:[rect.width,rect.height]}};
}
for(const scale of [1,2])test(`independent scale${scale} output maps physical pixels into logical desktop`,()=>{
 const result=proveWaylandCapture(example(scale));assert.equal(result.scale,scale);assert.deepEqual(result.desktopRect,{x:0,y:0,width:1280/scale,height:960/scale});
});
for(const fault of ['unscaled-image','wrong-logical-rect','wrong-units','extra-output-region','changed-scale','changed-output','changed-fixture-birth','changed-compositor-birth','changed-window','lost-focus','stale-receipt','expired-monotonic-bracket','missing-clock','mislabeled-format','non-screen','wrong-fixture-origin','unknown-scale'])test(`Wayland proof rejects ${fault}`,()=>{
 const x=example(2);
 if(fault==='unscaled-image')x.decodedDimensions={width:640,height:480};
 if(fault==='wrong-logical-rect')x.receipt.geometry.regions[0].desktopRect={x:0,y:0,width:1280,height:960};
 if(fault==='wrong-units')x.receipt.geometry.coordinateUnits='desktop-physical-pixels';
 if(fault==='extra-output-region')x.receipt.geometry.regions.push(x.receipt.geometry.regions[0]);
 if(fault==='changed-scale')x.after.output.scale=1;
 if(fault==='changed-output')x.after.output.name='HEADLESS-2';
 if(fault==='changed-fixture-birth')x.after.fixtureStartTicks='124';
 if(fault==='changed-compositor-birth')x.after.compositorStartTicks='101';
 if(fault==='changed-window')x.after.windowId++;
 if(fault==='lost-focus')x.after.focused=false;
 if(fault==='stale-receipt')x.receipt.capturedAtMs=999;
 if(fault==='expired-monotonic-bracket')x.after.finishedMonotonicMs=30_000;
 if(fault==='missing-clock')delete x.before.startedMonotonicMs;
 if(fault==='mislabeled-format')x.decodedMimeType='image/jpeg';
 if(fault==='non-screen')x.receipt.requestedScope.mode='frontmost';
 if(fault==='wrong-fixture-origin')x.fixture.origin=[100,100];
 if(fault==='unknown-scale')x.before.output.scale=x.after.output.scale=1.5;
 assert.throws(()=>proveWaylandCapture(x));
});
function compositor(scale=1) {
 const x=example(scale),rect=x.before.output.rect;
 return {version:{variant:'sway',major:1,minor:7,patch:0,human_readable:'1.7'},outputs:[{name:'HEADLESS-1',active:true,make:'headless',model:'headless',rect,scale,transform:'normal',current_mode:{width:1280,height:960}}],tree:{nodes:[{id:5,pid:42,name:'Owned Wayland Fixture',focused:true,rect,nodes:[]}],floating_nodes:[]},fixturePid:42,fixtureTitle:'Owned Wayland Fixture'};
}
for(const scale of [1,2])test(`compositor scale${scale} snapshot derives actual physical/logical extents`,()=>{
 const s=normalizeWaylandSnapshot(compositor(scale));assert.equal(s.output.scale,scale);assert.deepEqual(s.output.physicalSize,{width:1280,height:960});
});
for(const fault of ['physical-output','multiple-outputs','inactive','wrong-pid','wrong-title','unfocused','duplicate-window','wrong-version','mode-scale-mismatch'])test(`compositor snapshot rejects ${fault}`,()=>{
 const c=compositor(2);
 if(fault==='physical-output')c.outputs[0].make='physical';
 if(fault==='multiple-outputs')c.outputs.push(c.outputs[0]);
 if(fault==='inactive')c.outputs[0].active=false;
 if(fault==='wrong-pid')c.tree.nodes[0].pid=43;
 if(fault==='wrong-title')c.tree.nodes[0].name='Other window';
 if(fault==='unfocused')c.tree.nodes[0].focused=false;
 if(fault==='duplicate-window')c.tree.nodes.push(c.tree.nodes[0]);
 if(fault==='wrong-version')c.version.minor=8;
 if(fault==='mode-scale-mismatch')c.outputs[0].current_mode.width=640;
 assert.throws(()=>normalizeWaylandSnapshot(c));
});
