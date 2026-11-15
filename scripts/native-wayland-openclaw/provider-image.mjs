import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { proveWaylandCapture } from './wayland-scope-proof.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const text=value=>typeof value==='string'?value:(value??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const rectangle=([x,y,width,height])=>({x,y,width,height});
const cleanRect=({x,y,width,height})=>({x,y,width,height});
const colors=new Map([['NW',[40,210,220]],['NE',[200,60,210]],['SW',[250,145,30]],['SE',[225,235,250]]]);

// Verifies the supplied provider-image content and independent snapshot relation.
// Live HTTP, fixture provenance and actual approval are separate runner evidence.
export async function proveProviderImage(body,marker,options={}) {
  let stage='turn';
  try {
    const {sharp,fixture,before,after,format,expectedCallId,captureStartedAtMs,seenObservationIds}=options;
    assert.ok(Array.isArray(body.messages)&&body.messages.length<=300);
    assert.match(marker,/^[a-z0-9-]{1,64}$/);
    assert.match(expectedCallId,/^[A-Za-z0-9]{1,40}$/);
    assert.ok(Number.isSafeInteger(captureStartedAtMs)&&seenObservationIds instanceof Set);
    const turns=body.messages.flatMap((m,index)=>m.role==='user'?[...text(m.content).matchAll(/WAYLAND21_CASE:([a-z0-9-]{1,64})(?![a-z0-9-])/g)].map(v=>({marker:v[1],index})):[]);
    assert.equal(turns.at(-1)?.marker,marker);assert.equal(turns.filter(v=>v.marker===marker).length,1);
    const current=body.messages.slice(turns.at(-1).index+1),images=[];
    for(const message of current) if(message.role==='user'&&Array.isArray(message.content)) for(const block of message.content) if(block?.type==='image_url') {
      assert.ok(typeof block.image_url?.url==='string');images.push(block.image_url.url);
    }
    assert.equal(images.length,1);assert.ok(images[0].length<=24*1024*1024);
    const observations=current.filter(m=>m.role==='tool').flatMap(message=>{try{const details=JSON.parse(text(message.content));return details?.observationV1?[{message,details}]:[];}catch{return[];}});
    assert.equal(observations.length,1);const {message,details}=observations[0];
    stage='capture-binding';
    assert.equal(message.tool_call_id,expectedCallId);assert.equal(details.status,'success');assert.equal(details.success,true);
    const receipt=details.observationV1;assert.equal(receipt.schemaVersion,1);
    assert.ok(typeof receipt.observationId==='string'&&receipt.observationId.length>0&&receipt.observationId.length<=256&&!seenObservationIds.has(receipt.observationId));
    assert.ok(Number.isSafeInteger(receipt.capturedAtMs)&&receipt.capturedAtMs>=captureStartedAtMs&&receipt.capturedAtMs<=Date.now());
    stage='encoding';
    const [,mimeType,encoded]=images[0].match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/)??[];assert.ok(mimeType&&encoded);
    const bytes=Buffer.from(encoded,'base64');assert.equal(bytes.toString('base64'),encoded);
    const primary=receipt.primaryImage;assert.equal(bytes.length,primary.byteLength);assert.equal(hash(bytes),primary.sha256);assert.equal(mimeType,primary.mimeType);
    const decoder=()=>sharp(bytes,{limitInputPixels:16*1024*1024,failOn:'warning'});
    const metadata=await decoder().metadata(),decodedMimeType=metadata.format==='png'?'image/png':metadata.format==='jpeg'?'image/jpeg':'invalid';
    assert.equal(decodedMimeType,mimeType);const dimensions={width:metadata.width,height:metadata.height};
    assert.equal(receipt.coordinateReference?.units,'normalized');assert.deepEqual(receipt.coordinateReference.sourceExtent,{x:0,y:0,...dimensions});
    assert.equal(receipt.requestedScope.annotationRequested,false);
    stage='scope';
    const scope=proveWaylandCapture({before,after,receipt,fixture,format,imageMimeType:mimeType,decodedDimensions:dimensions,decodedMimeType});
    stage='pixels';
    assert.equal(fixture.clickCount,0);assert.ok(Array.isArray(fixture.targetRect)&&fixture.targetRect.length===4&&fixture.targetRect.every(Number.isSafeInteger));
    const expectedTarget=rectangle(fixture.targetRect);assert.ok(expectedTarget.width>0&&expectedTarget.height>0);
    assert.ok(expectedTarget.x>=0&&expectedTarget.y>=0&&expectedTarget.x+expectedTarget.width<=fixture.size[0]&&expectedTarget.y+expectedTarget.height<=fixture.size[1]);
    const {data,info}=await decoder().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.channels,4);
    function opaque(left,top,right,bottom){assert.ok(left>=0&&top>=0&&right<=info.width&&bottom<=info.height);for(let y=Math.floor(top);y<Math.ceil(bottom);y++)for(let x=Math.floor(left);x<Math.ceil(right);x++)assert.equal(data[(y*info.width+x)*4+3],255);}
    const region=receipt.geometry.regions[0],r=region.imageRect,d=region.desktopRect,tolerance=16;
    const desktopPoint=p=>[d.x+(p[0]-r.x)*d.width/r.width,d.y+(p[1]-r.y)*d.height/r.height];
    const imagePoint=p=>[r.x+(p[0]-d.x)*r.width/d.width,r.y+(p[1]-d.y)*r.height/d.height];
    let minX=info.width,minY=info.height,maxX=-1,maxY=-1,count=0;
    for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
      const offset=(y*info.width+x)*info.channels;
      if(data[offset+3]===255&&[224,48,64].every((v,c)=>Math.abs(data[offset+c]-v)<=tolerance)){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);count++;}
    }
    assert.ok(count>0&&count/((maxX-minX+1)*(maxY-minY+1))>.9);
    opaque(minX,minY,maxX+1,maxY+1);
    const observedImagePoint=[(minX+maxX+1)/2,(minY+maxY+1)/2],observedDesktopPoint=desktopPoint(observedImagePoint);
    const expectedEdges=[fixture.origin[0]+expectedTarget.x,fixture.origin[1]+expectedTarget.y,fixture.origin[0]+expectedTarget.x+expectedTarget.width,fixture.origin[1]+expectedTarget.y+expectedTarget.height];
    const mappedEdges=[...desktopPoint([minX,minY]),...desktopPoint([maxX+1,maxY+1])];
    assert.ok(mappedEdges.every((v,i)=>Math.abs(v-expectedEdges[i])<=2));
    assert.ok(mappedEdges[0]>=fixture.origin[0]&&mappedEdges[1]>=fixture.origin[1]&&mappedEdges[2]<=fixture.origin[0]+fixture.size[0]&&mappedEdges[3]<=fixture.origin[1]+fixture.size[1]);
    opaque(...imagePoint(expectedEdges.slice(0,2)),...imagePoint(expectedEdges.slice(2)));
    stage='landmarks';
    assert.ok(Array.isArray(fixture.landmarks)&&fixture.landmarks.length===4&&new Set(fixture.landmarks.map(v=>v.name)).size===4);
    const landmarks=fixture.landmarks.map(value=>{
      assert.ok(colors.has(value.name));assert.deepEqual(value.rgb,colors.get(value.name));
      assert.ok(Array.isArray(value.rect)&&value.rect.length===4&&value.rect.every(Number.isSafeInteger));const q=rectangle(value.rect);
      assert.ok(q.x>=0&&q.y>=0&&q.width>0&&q.height>0&&q.x+q.width<=fixture.size[0]&&q.y+q.height<=fixture.size[1]);
      const expected=[fixture.origin[0]+q.x+q.width/2,fixture.origin[1]+q.y+q.height/2],point=imagePoint(expected),x=Math.floor(point[0]),y=Math.floor(point[1]);
      assert.ok(x>=0&&y>=0&&x<info.width&&y<info.height);
      const low=imagePoint([fixture.origin[0]+q.x,fixture.origin[1]+q.y]),high=imagePoint([fixture.origin[0]+q.x+q.width,fixture.origin[1]+q.y+q.height]);opaque(...low,...high);
      const offset=(y*info.width+x)*info.channels;assert.ok(value.rgb.every((v,c)=>Math.abs(data[offset+c]-v)<=tolerance));
      return{name:value.name,imagePoint:point,desktopPoint:expected};
    });
    seenObservationIds.add(receipt.observationId);
    return {providerImageVerified:true,observationIdSha256:hash(receipt.observationId),capturedAtMs:receipt.capturedAtMs,toolCallId:expectedCallId,sha256:hash(bytes),byteLength:bytes.length,mimeType,dimensions,scale:scope.scale,imagePoint:observedImagePoint,desktopPoint:observedDesktopPoint,targetPixelBounds:[minX,minY,maxX+1,maxY+1],landmarks,colorTolerance:tolerance,independentExtent:{desktopRect:cleanRect(scope.desktopRect),physicalDimensions:{...dimensions},windowRect:cleanRect(scope.windowRect),bracketDurationMs:scope.bracketDurationMs}};
  } catch {
    const error=new Error('WAYLAND_PROVIDER_IMAGE_REJECTED');error.code='WAYLAND_PROVIDER_IMAGE_REJECTED';error.stage=stage;throw error;
  }
}
