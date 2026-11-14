import assert from 'node:assert/strict';
import test from 'node:test';
import { proveTextEffect, proveScrollEffect } from './linux-control-proof.mjs';
const before = () => ({ready:true,pid:42,origin:[100,120],size:[640,480],text:'',scrollOffset:0,scrollUpper:720,scrollPageSize:220,keys:[]});
test('actual editable value, not key delivery, proves typed text',()=>{
 const b=before(),a={...b,text:'fixture proof',keys:[{name:'f'}]};
 assert.deepEqual(proveTextEffect(b,a,'fixture proof'),{observedEditableValue:true,characters:13});
});
test('key count alone cannot prove editable-text input',()=>{
 const b=before();assert.throws(()=>proveTextEffect(b,{...b,keys:[{name:'f'}]},'fixture proof'));
});
test('actual viewport movement proves scrolling',()=>{
 const b=before();assert.deepEqual(proveScrollEffect(b,{...b,scrollOffset:75}),{observedViewportMovement:true,before:0,after:75,delta:75});
});
for(const bad of ['no-movement','outside-range','nonfinite','changed-fixture','changed-origin'])test(`scroll proof rejects ${bad}`,()=>{
 const b=before(),a={...b,scrollOffset:75};
 if(bad==='no-movement')a.scrollOffset=0;
 if(bad==='outside-range')a.scrollOffset=900;
 if(bad==='nonfinite')a.scrollOffset=NaN;
 if(bad==='changed-fixture')a.pid++;
 if(bad==='changed-origin')a.origin=[0,0];
 assert.throws(()=>proveScrollEffect(b,a));
});
