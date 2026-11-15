import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { proveProviderImage } from './provider-image.mjs';
const host=process.env.NATIVE_OPENCLAW_HOST;
assert.ok(host,'Select the retained installed official OpenClaw package');
const sharp=createRequire(`${host}/package.json`)('sharp');
const hash=b=>createHash('sha256').update(b).digest('hex');
const colors=[['NW',[40,210,220]],['NE',[200,60,210]],['SW',[250,145,30]],['SE',[225,235,250]]];
async function sample(scale=1,format='png') {
  const width=640*scale,height=480*scale,pixels=Buffer.alloc(width*height*3);
  for(let p=0;p<pixels.length;p+=3)pixels.set([20,40,80],p);
  function fill(rect,rgb){for(let y=rect[1]*scale;y<(rect[1]+rect[3])*scale;y++)for(let x=rect[0]*scale;x<(rect[0]+rect[2])*scale;x++)pixels.set(rgb,(y*width+x)*3);}
  const targetRect=[20,20,120,80];fill(targetRect,[224,48,64]);
  const rects=[[4,4,16,16],[620,4,16,16],[4,448,16,16],[620,448,16,16]];
  const landmarks=colors.map(([name,rgb],i)=>{fill(rects[i],rgb);return{name,rgb,rect:rects[i]};});
  const image=sharp(pixels,{raw:{width,height,channels:3}}),bytes=await(format==='png'?image.png():image.jpeg({quality:95})).toBuffer();
  const at=Date.now()-10,rect={x:-100,y:20,width:640,height:480},dims={width,height};
  const before={fixturePid:123,fixtureStartTicks:'111',compositorPid:456,compositorStartTicks:'222',windowId:5,windowRect:{...rect},focused:true,output:{name:'HEADLESS-1',rect:{...rect},physicalSize:dims,scale,transform:'normal'},startedAtMs:at-4,finishedAtMs:at-2,startedMonotonicMs:10,finishedMonotonicMs:12};
  const after={...structuredClone(before),startedAtMs:at+2,finishedAtMs:at+4,startedMonotonicMs:14,finishedMonotonicMs:16};
  const mimeType=format==='png'?'image/png':'image/jpeg';
  const receipt={schemaVersion:1,observationId:'observation-test-one',capturedAtMs:at,requestedScope:{mode:'screen',annotationRequested:false},actualScope:{state:'available',mode:'screen'},primaryImage:{mimeType,sha256:hash(bytes),byteLength:bytes.length,sourceDimensions:dims,deliveredDimensions:dims},coordinateReference:{units:'normalized',sourceExtent:{x:0,y:0,...dims}},geometry:{state:'available',coordinateUnits:'desktop-logical-pixels',regions:[{displayId:'HEADLESS-1',imageRect:{x:0,y:0,...dims},desktopRect:{...rect}}]}};
  const body={messages:[{role:'user',content:'WAYLAND21_CASE:allowed'},{role:'tool',tool_call_id:'wl21capture1',content:''},{role:'user',content:[{type:'image_url',image_url:{url:`data:${mimeType};base64,${bytes.toString('base64')}`}}]}]};
  const fixture={pid:123,origin:[rect.x,rect.y],size:[640,480],clickCount:0,targetRect,landmarks};
  const update=()=>{body.messages[1].content=JSON.stringify({status:'success',success:true,observationV1:receipt});};update();
  return {body,receipt,fixture,before,after,bytes,update,options:{sharp,fixture,before,after,format,expectedCallId:'wl21capture1',captureStartedAtMs:at-1,seenObservationIds:new Set()}};
}
for(const scale of [1,2])for(const format of ['png','jpg'])test(`provider ${format} pixels preserve the independent logical mapping at scale ${scale}`,async()=>{
  const s=await sample(scale,format);const proof=await proveProviderImage(s.body,'allowed',s.options);
  assert.equal(proof.providerImageVerified,true);assert.equal(proof.scale,scale);assert.deepEqual(proof.desktopPoint,[-20,80]);assert.deepEqual(proof.imagePoint,[80*scale,60*scale]);assert.equal(proof.landmarks.length,4);assert.equal(proof.mimeType,format==='png'?'image/png':'image/jpeg');assert.equal(proof.sha256,hash(s.bytes));assert.ok(!JSON.stringify(proof).includes('base64'));assert.equal(Object.hasOwn(proof,'nativeExecuted'),false);assert.equal(Object.hasOwn(proof,'actualProviderRequest'),false);
});
for(const variant of ['wrong-call','stale','reused-id','hash','mime','dimensions','missing-image','duplicate-image','duplicate-observation','later-turn','wrong-mode','wrong-units','moved-window','changed-birth','expired-bracket','wrong-target','wrong-landmark','duplicate-landmark','contradictory-status'])test(`provider rejects ${variant} before input`,async()=>{
  const s=await sample();
  if(variant==='wrong-call')s.body.messages[1].tool_call_id='other';
  if(variant==='stale')s.receipt.capturedAtMs=0;
  if(variant==='reused-id')s.options.seenObservationIds.add(s.receipt.observationId);
  if(variant==='hash')s.receipt.primaryImage.sha256='0'.repeat(64);
  if(variant==='mime')s.receipt.primaryImage.mimeType='image/jpeg';
  if(variant==='dimensions')s.receipt.primaryImage.sourceDimensions={width:641,height:480};
  if(variant==='missing-image')s.body.messages.pop();
  if(variant==='duplicate-image')s.body.messages.push(structuredClone(s.body.messages.at(-1)));
  if(variant==='later-turn')s.body.messages.push({role:'user',content:'WAYLAND21_CASE:later'});
  if(variant==='wrong-mode')s.receipt.actualScope.mode='frontmost';
  if(variant==='wrong-units')s.receipt.geometry.coordinateUnits='desktop-physical-pixels';
  if(variant==='moved-window')s.after.windowRect.x++;
  if(variant==='changed-birth')s.after.fixtureStartTicks='333';
  if(variant==='expired-bracket')s.after.finishedMonotonicMs+=21000;
  if(variant==='wrong-target')s.fixture.targetRect=[30,20,120,80];
  if(variant==='wrong-landmark')s.fixture.landmarks[0].rgb=[0,0,0];
  if(variant==='duplicate-landmark')s.fixture.landmarks[1]=structuredClone(s.fixture.landmarks[0]);
  s.update();
  if(variant==='duplicate-observation')s.body.messages.push(structuredClone(s.body.messages[1]));
  if(variant==='contradictory-status'){const d=JSON.parse(s.body.messages[1].content);d.status='error';s.body.messages[1].content=JSON.stringify(d);}
  await assert.rejects(proveProviderImage(s.body,'allowed',s.options));
});
test('retained older images cannot substitute for the current capture',async()=>{
  const s=await sample();s.body.messages.unshift({role:'user',content:'WAYLAND21_CASE:older'},{role:'user',content:structuredClone(s.body.messages[2].content)});
  const proof=await proveProviderImage(s.body,'allowed',s.options);assert.equal(proof.sha256,hash(s.bytes));
});
test('successful and failed proof metadata excludes arbitrary raw fields',async()=>{
  const s=await sample();const secret='private-provider-marker';s.receipt.actualScope.rawPrivateValue=secret;s.receipt.observationId=secret;s.update();
  const proof=await proveProviderImage(s.body,'allowed',s.options);assert.ok(!JSON.stringify(proof).includes(secret));
  const bad=await sample();bad.body.messages[1].content=JSON.stringify({status:secret,success:true,observationV1:bad.receipt});
  await assert.rejects(proveProviderImage(bad.body,'allowed',bad.options),error=>{assert.ok(!JSON.stringify(error).includes(secret));assert.ok(!String(error).includes(secret));assert.equal(error.code,'WAYLAND_PROVIDER_IMAGE_REJECTED');return true;});
});

for(const variant of ['plain-string','text-block','metadata','wrong-block-type','wrong-role'])test(`review rejects image-like data in ${variant}`,async()=>{
  const s=await sample(),uri=s.body.messages[2].content[0].image_url.url;
  if(variant==='plain-string')s.body.messages[2].content=uri;
  if(variant==='text-block')s.body.messages[2].content=[{type:'text',text:uri}];
  if(variant==='metadata'){s.body.messages[2].content=[];s.body.messages[2].unrelated={image:uri};}
  if(variant==='wrong-block-type')s.body.messages[2].content=[{type:'not-an-image',image_url:{url:uri}}];
  if(variant==='wrong-role')s.body.messages[2].role='assistant';
  await assert.rejects(proveProviderImage(s.body,'allowed',s.options));
});
for(const alpha of [0,.5,1])test(`review requires visible PNG proof pixels at alpha ${alpha}`,async()=>{
  const s=await sample();const bytes=await sharp(s.bytes).ensureAlpha(alpha).png().toBuffer();
  s.receipt.primaryImage.sha256=hash(bytes);s.receipt.primaryImage.byteLength=bytes.length;s.body.messages[2].content[0].image_url.url=`data:image/png;base64,${bytes.toString('base64')}`;s.update();
  if(alpha<1)await assert.rejects(proveProviderImage(s.body,'allowed',s.options));
  else assert.equal((await proveProviderImage(s.body,'allowed',s.options)).providerImageVerified,true);
});
for(const variant of ['beyond-window','negative-local-origin'])test(`review rejects a decoded target ${variant} despite matching screen pixels`,async()=>{
  const s=await sample(),width=1280,height=960,pixels=Buffer.alloc(width*height*3);
  const outputX=variant==='negative-local-origin'?-150:-100,windowX=-100,localX=variant==='negative-local-origin'?-30:650;
  const offset=windowX-outputX,rect={x:outputX,y:20,width,height},window={x:windowX,y:20,width:640,height:480};
  for(let p=0;p<pixels.length;p+=3)pixels.set([20,40,80],p);
  function fill(x,y,w,h,rgb){for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)pixels.set(rgb,(j*width+i)*3);}
  fill(offset+localX,20,120,80,[224,48,64]);
  for(const landmark of s.fixture.landmarks)fill(offset+landmark.rect[0],landmark.rect[1],landmark.rect[2],landmark.rect[3],landmark.rgb);
  const bytes=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
  for(const snapshot of [s.before,s.after]){snapshot.windowRect={...window};snapshot.output.rect={...rect};snapshot.output.physicalSize={width,height};}
  s.fixture.targetRect=[localX,20,120,80];s.receipt.primaryImage={...s.receipt.primaryImage,sha256:hash(bytes),byteLength:bytes.length,sourceDimensions:{width,height},deliveredDimensions:{width,height}};
  s.receipt.coordinateReference.sourceExtent={x:0,y:0,width,height};s.receipt.geometry.regions=[{displayId:'HEADLESS-1',imageRect:{x:0,y:0,width,height},desktopRect:{...rect}}];
  s.body.messages[2].content[0].image_url.url=`data:image/png;base64,${bytes.toString('base64')}`;s.update();
  await assert.rejects(proveProviderImage(s.body,'allowed',s.options));
});

test('edge tolerance cannot place a tiny target outside the independent window',async()=>{
  const s=await sample(),width=1280,height=960,pixels=Buffer.alloc(width*height*3),rect={x:-150,y:20,width,height};
  for(let p=0;p<pixels.length;p+=3)pixels.set([20,40,80],p);
  function fill(x,y,w,h,rgb){for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)pixels.set(rgb,(j*width+i)*3);}
  fill(48,20,1,80,[224,48,64]);
  for(const landmark of s.fixture.landmarks)fill(50+landmark.rect[0],landmark.rect[1],landmark.rect[2],landmark.rect[3],landmark.rgb);
  const bytes=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
  for(const snapshot of [s.before,s.after]){snapshot.output.rect={...rect};snapshot.output.physicalSize={width,height};}
  s.fixture.targetRect=[0,20,1,80];s.receipt.primaryImage={...s.receipt.primaryImage,sha256:hash(bytes),byteLength:bytes.length,sourceDimensions:{width,height},deliveredDimensions:{width,height}};
  s.receipt.coordinateReference.sourceExtent={x:0,y:0,width,height};s.receipt.geometry.regions=[{displayId:'HEADLESS-1',imageRect:{x:0,y:0,width,height},desktopRect:{...rect}}];
  s.body.messages[2].content[0].image_url.url=`data:image/png;base64,${bytes.toString('base64')}`;s.update();
  await assert.rejects(proveProviderImage(s.body,'allowed',s.options));
});

test('opaque inset pixels cannot hide a transparent declared target perimeter',async()=>{
  const s=await sample();const {data,info}=await sharp(s.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(let y=20;y<100;y++)for(let x=20;x<140;x++)if(x===20||x===139||y===20||y===99)data[(y*info.width+x)*4+3]=0;
  const bytes=await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer();
  s.receipt.primaryImage.sha256=hash(bytes);s.receipt.primaryImage.byteLength=bytes.length;s.body.messages[2].content[0].image_url.url=`data:image/png;base64,${bytes.toString('base64')}`;s.update();
  await assert.rejects(proveProviderImage(s.body,'allowed',s.options));
});

// Fixed diagnostics distinguish an image proof rejection without retaining raw requests.
test('provider image failure stage survives the runner boundary without private error text',async()=>{
  const api=await import('./provider-image.mjs');
  const s=await sample();s.receipt.primaryImage.sha256='0'.repeat(64);s.update();
  let failed;try{await proveProviderImage(s.body,'allowed',s.options);}catch(error){failed=error;}
  assert.equal(api.providerImageFailureStage?.(failed),'encoding');
});
test('provider image failure stage rejects arbitrary fields and throwing getters',async()=>{
  const api=await import('./provider-image.mjs');
  for(const value of [{code:'WAYLAND_PROVIDER_IMAGE_REJECTED',stage:'private-stage'},{code:'private-error',stage:'pixels'},null,new Proxy({},{get(){throw Error('private getter');}})])assert.equal(api.providerImageFailureStage?.(value),'unknown');
});
