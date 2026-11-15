import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The real API used by Peekaboo SnapshotManager, without loading that helper or a GUI.
const foundationHome = String.raw`import ctypes,json,sys,os
ctypes.CDLL('/System/Library/Frameworks/Foundation.framework/Foundation')
objc=ctypes.CDLL('/usr/lib/libobjc.A.dylib')
objc.objc_getClass.argtypes=[ctypes.c_char_p];objc.objc_getClass.restype=ctypes.c_void_p
objc.sel_registerName.argtypes=[ctypes.c_char_p];objc.sel_registerName.restype=ctypes.c_void_p
send=ctypes.CFUNCTYPE(ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p)(('objc_msgSend',objc))
text=ctypes.CFUNCTYPE(ctypes.c_char_p,ctypes.c_void_p,ctypes.c_void_p)(('objc_msgSend',objc))
selector=lambda name:objc.sel_registerName(name.encode())
manager=send(objc.objc_getClass(b'NSFileManager'),selector('defaultManager'));assert manager
home=send(manager,selector('homeDirectoryForCurrentUser'));assert home
path=text(home,selector('fileSystemRepresentation')).decode()
print(json.dumps({'fileManagerHomeMatchesTaskHome':os.path.realpath(path)==os.path.realpath(sys.argv[1]),'desktopOrHelperInvoked':False}))`;

async function privateHome(run) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'native-helper-home-'))),home=join(root,'home');
  await mkdir(home,{mode:0o700});
  try {await run(home,root);} finally {await rm(root,{recursive:true,force:true});}
}

test('Mac helper environment keeps real Foundation snapshots in the private home',{skip:process.platform!=='darwin'},async()=>{
  const {nativeHelperHomeEnvironment}=await import('./helper-home.mjs');
  await privateHome(async(home,root)=>{
    const env={PATH:process.env.PATH,TMPDIR:root,LANG:'en_US.UTF-8',...nativeHelperHomeEnvironment(home,'darwin')};
    const child=spawnSync('python3',['-I','-B','-c',foundationHome,home],{env,encoding:'utf8',timeout:10_000,maxBuffer:64*1024});
    assert.ifError(child.error);assert.equal(child.status,0,'Foundation-only metadata probe must complete');
    assert.deepEqual(JSON.parse(child.stdout),{fileManagerHomeMatchesTaskHome:true,desktopOrHelperInvoked:false});
  });
});

test('Mac isolation leaves the Linux caller home unchanged',async()=>{
  const {nativeHelperHomeEnvironment}=await import('./helper-home.mjs');
  await privateHome(async(home,root)=>{
    const callerHome=join(root,'linux-caller-home');
    const env={PATH:process.env.PATH,TMPDIR:root,HOME:callerHome,...nativeHelperHomeEnvironment(home,'linux')};
    const child=spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(require('node:os').homedir()))"],{env,encoding:'utf8',timeout:5000});
    assert.ifError(child.error);assert.equal(child.status,0);assert.equal(JSON.parse(child.stdout),callerHome);
  });
});

test('invalid helper home cannot silently select the operator home',async()=>{
  const {nativeHelperHomeEnvironment}=await import('./helper-home.mjs');
  for(const home of ['',null,'relative-home','/private-invalid\0value'])assert.throws(()=>nativeHelperHomeEnvironment(home,'darwin'),error=>error.message==='NATIVE_HELPER_HOME_REJECTED');
});
