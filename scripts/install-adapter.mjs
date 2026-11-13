#!/usr/bin/env node
/** Explicit local paired installation. This module never mutates host configuration or installs helpers. */
import { mkdir, mkdtemp, writeFile, readFile, lstat, stat, rename, rm, chmod, readdir, realpath, access, open } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, release } from 'node:os';
import { join, resolve, dirname, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest, readRegular, sha256, describeArchive, inspectPair, assertIdentity, REPOSITORY, WORKFLOW, fail } from './release-manifest.mjs';
const VERSION = /^0\.1\.[0-9]+$/;
const json = bytes => { try { return JSON.parse(bytes.toString()); } catch { fail('RELEASE_JSON_INVALID'); } };
function run(file,args,timeout=15000) { return execFileSync(file,args,{encoding:'utf8',timeout,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,GH_HOST:'github.com'}}); }
function policyFor(version, trusted) {
  if(!VERSION.test(version))fail('RELEASE_VERSION_REQUIRED');
  if(!trusted)return {sourceCommit:null,sourceRef:`refs/tags/v${version}`,candidate:false};
  if(!/^[a-f0-9]{40}$/.test(trusted.sourceCommit)||!/^refs\/(heads\/[A-Za-z0-9_./-]+|pull\/[0-9]+\/merge)$/.test(trusted.sourceRef))fail('RELEASE_CANDIDATE_POLICY_INVALID');
  return {...trusted,candidate:true};
}
function checkPolicy(m,version,policy) {
  if(m.releaseVersion!==version || m.source.ref!==policy.sourceRef || (policy.candidate ? m.source.tag!==null||m.source.commit!==policy.sourceCommit : m.source.tag!==`v${version}`))fail('RELEASE_SOURCE_POLICY_MISMATCH');
}
function verifierPrerequisite() {
  try { const help=run('gh',['attestation','verify','--help']);for(const flag of ['--source-digest','--source-ref','--signer-workflow','--deny-self-hosted-runners','--format'])if(!help.includes(flag))fail(); }
  catch { fail('RELEASE_VERIFIER_REQUIRED: install a gh version supporting source/ref/workflow attestation verification yourself'); }
}
function verify(path,m,policy) {
  try {
    const result=json(run('gh',['attestation','verify',path,'--repo',REPOSITORY,'--signer-workflow',WORKFLOW,'--source-digest',m.source.commit,'--source-ref',policy.sourceRef,'--deny-self-hosted-runners','--predicate-type','https://slsa.dev/provenance/v1','--format','json'],120000));
    if(!Array.isArray(result)||result.length===0)fail();
  } catch { fail('RELEASE_PROVENANCE_FAILED'); }
}
const atLeast=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);if(x.some(n=>!Number.isFinite(n)))return false;for(let i=0;i<y.length;i++){if((x[i]??0)>y[i])return true;if((x[i]??0)<y[i])return false;}return true;};
export function detectedTarget() {
  if(!['arm64','x64'].includes(process.arch)||!['linux','darwin'].includes(process.platform))fail('RELEASE_HOST_UNSUPPORTED');
  return `${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux-gnu'}`;
}
async function compatibleHost(artifact) {
  if(artifact.target!==detectedTarget())fail('RELEASE_TARGET_INCOMPATIBLE');
  if(process.platform==='darwin') { if(!atLeast(run('/usr/bin/sw_vers',['-productVersion']).trim(),artifact.minimumOsVersion))fail('RELEASE_OS_UNSUPPORTED'); }
  else {
    const os=await readFile('/etc/os-release','utf8');const field=k=>os.match(new RegExp(`^${k}="?([^"\\n]+)"?$`,'m'))?.[1];
    if(field('ID')!=='ubuntu'||!atLeast(field('VERSION_ID')??'',artifact.minimumOsVersion)||!atLeast(process.report.getReport().header.glibcVersionRuntime??'',artifact.libc.minimumVersion)||!atLeast(release().split('-')[0],'5.15'))fail('RELEASE_OS_UNSUPPORTED');
  }
}
async function directory(path,create=false) {
  if(create)await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const stat=await lstat(path); if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))fail('RELEASE_PRIVATE_ROOT_REQUIRED');
}
async function withRoot(root,work) {
  if(!root||!isAbsolute(root))fail('RELEASE_PRIVATE_ROOT_REQUIRED');root=resolve(root);
  await directory(root,true);const canonical=await realpath(root);if(canonical!==join(await realpath(dirname(root)),root.split('/').at(-1)))fail('RELEASE_PRIVATE_ROOT_REQUIRED');
  const lock=join(root,'.install-lock');try{await mkdir(lock,{mode:0o700});}catch{fail('RELEASE_INSTALL_LOCKED');}
  try{return await work(root);}finally{await rm(lock,{recursive:true,force:true});}
}
async function durableJson(path,value) { const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();} }
async function syncDirectory(path) {const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
function bytesMatch(data,asset) {if(data.length!==asset.bytes||sha256(data)!==asset.sha256)fail('RELEASE_ASSET_MISMATCH');const actual=describeArchive(asset.asset,data);if(JSON.stringify(actual.entries)!==JSON.stringify(asset.entries))fail('RELEASE_ARCHIVE_ENTRIES_MISMATCH');}
async function extract(entries,destination) {await mkdir(destination,{mode:0o700});for(const e of entries){const path=join(destination,e.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,e.data,{flag:'wx',mode:e.executable?0o500:0o400});}}
async function seal(path) {for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isDirectory())await seal(p);else await chmod(p,(await lstat(p)).mode&0o111?0o500:0o400);}await chmod(path,0o500);}
async function checkExtracted(base,entries) {
  const expected=new Set(entries.map(e=>e.path));const found=[];
  async function walk(path,relative='') {await directory(path);for(const e of await readdir(path,{withFileTypes:true})){const name=relative?relative+'/'+e.name:e.name;const p=join(path,e.name);if(e.isDirectory())await walk(p,name);else{if(!e.isFile()||!expected.has(name))fail('RELEASE_STAGED_CONTENT_CHANGED');found.push(name);}}}
  await walk(base);if(found.length!==entries.length)fail('RELEASE_STAGED_CONTENT_CHANGED');
  for(const e of entries){const p=join(base,e.path),b=await readRegular(p);if(b.length!==e.bytes||sha256(b)!==e.sha256||Boolean((await lstat(p)).mode&0o111)!==e.executable)fail('RELEASE_STAGED_CONTENT_CHANGED');}
}
function executableIdentity(path,m,target) {try{const identity=json(run(path,['--version']));assertIdentity(identity,m,target);return identity;}catch{fail('RELEASE_EXECUTABLE_IDENTITY_MISMATCH');}}
async function stage(options,trusted) {
  const {version,manifest:manifestPath,assets,target}=options,policy=policyFor(version,trusted);
  verifierPrerequisite();
  return withRoot(options.root,async root=>{
    const versions=join(root,'versions');await directory(versions,true);const final=join(versions,version);
    try{await lstat(final);fail('RELEASE_VERSION_ALREADY_STAGED');}catch(e){if(e.code!=='ENOENT')throw e;}
    const staging=await mkdtemp(join(versions,'.stage-'));let phase='manifest-verification';
    try {
      const manifestBytes=await readRegular(manifestPath,2*1024*1024);const m=validateReleaseManifest(json(manifestBytes));checkPolicy(m,version,policy);
      const manifestCopy=join(staging,'release.json');await writeFile(manifestCopy,manifestBytes,{flag:'wx',mode:0o600});verify(manifestCopy,m,policy);
      const artifact=m.artifacts.find(a=>a.target===(target??detectedTarget()));if(!artifact)fail('RELEASE_TARGET_UNAVAILABLE');await compatibleHost(artifact);
      phase='asset-verification';const blobs=[];
      for(const asset of [m.package,artifact]){const bytes=await readRegular(join(assets,asset.asset));const path=join(staging,asset.asset);await writeFile(path,bytes,{flag:'wx',mode:0o600});verify(path,m,policy);bytesMatch(bytes,asset);blobs.push(bytes);}
      const pair=inspectPair(m,...blobs,artifact);phase='extraction';await extract(pair.pkg,join(staging,'package'));await extract(pair.native,join(staging,'native'));
      const adapter=join(staging,'native','coven-desktop-use');phase='executable-identity';const identity=executableIdentity(adapter,m,artifact.target);
      const receipt={schemaVersion:1,releaseVersion:version,sourceCommit:m.source.commit,target:artifact.target,manifestSha256:sha256(manifestBytes),provenance:{verifier:'gh',repository:REPOSITORY,workflow:WORKFLOW,sourceRef:policy.sourceRef,sourceCommit:m.source.commit,candidate:policy.candidate},identity,stagedAt:new Date().toISOString(),hostSynchronization:'not-performed'};
      await durableJson(join(staging,'receipt.json'),receipt);await seal(staging);phase='publish-stage';await rename(staging,final);await syncDirectory(versions);
      return {status:'staged',releaseVersion:version,versionDirectory:final,adapterPath:join(final,'native','coven-desktop-use'),packagePath:join(final,m.package.asset),activation:'not-performed',hostSynchronization:'not-performed'};
    } catch(e) {
      // Keep an interrupted stage visible for explicit recovery; never select it.
      e.releaseState={phase,stagingDirectory:staging,selectionChanged:false};throw e;
    }
  });
}
export const stageRelease=options=>stage(options);
/** Trusted CI entry only: caller supplies immutable job context; no verifier override exists. */
export const stageCandidateRelease=(options,trustedPolicy)=>{if(!trustedPolicy)fail('RELEASE_CANDIDATE_POLICY_REQUIRED');return stage(options,trustedPolicy);};
async function loadStaged(root,version,policy) {
  const folder=join(root,'versions',version);await directory(join(root,'versions'));await directory(folder);
  const manifestBytes=await readRegular(join(folder,'release.json'),2*1024*1024),m=validateReleaseManifest(json(manifestBytes));checkPolicy(m,version,policy);
  const receipt=json(await readRegular(join(folder,'receipt.json'),2*1024*1024));
  const a=m.artifacts.find(a=>a.target===receipt.target);if(!a||receipt.releaseVersion!==version||receipt.sourceCommit!==m.source.commit||receipt.manifestSha256!==sha256(manifestBytes)||receipt.provenance?.sourceRef!==policy.sourceRef||receipt.provenance?.candidate!==policy.candidate)fail('RELEASE_RECEIPT_INVALID');
  await compatibleHost(a);verify(join(folder,'release.json'),m,policy);
  const blobs=[];for(const asset of [m.package,a]){const path=join(folder,asset.asset);verify(path,m,policy);const bytes=await readRegular(path);bytesMatch(bytes,asset);blobs.push(bytes);}inspectPair(m,...blobs,a);
  await checkExtracted(join(folder,'package'),m.package.entries);await checkExtracted(join(folder,'native'),a.entries);executableIdentity(join(folder,'native','coven-desktop-use'),m,a.target);
  return {folder,m,receipt};
}
export async function inspectBinarySelection(adapterPath, {home=homedir(),environment=process.env}={}) {
  const cargo = join(home, '.cargo', 'bin', 'coven-desktop-use');
  let selected = environment.COVEN_DESKTOP_USE_BIN;
  let reason = 'COVEN_DESKTOP_USE_BIN';
  if (!selected) {
    const cargoExists = existsSync(cargo);
    selected = cargoExists ? cargo : 'coven-desktop-use';
    reason = cargoExists ? 'cargo' : 'PATH';
  }
  let executablePath = selected.includes('/') ? selected : null;
  if (!executablePath) {
    // The plugin passes bare names to execFile; match its Unix PATH lookup.
    for (const folder of (environment.PATH ?? '/usr/bin:/bin').split(delimiter)) {
      const candidate = resolve(folder, selected);
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        executablePath = candidate;
        break;
      } catch {}
    }
  }
  let version = null, resolvedPath = null;
  if (executablePath) {
    try {
      resolvedPath = await realpath(executablePath);
      version = json(run(executablePath, ['--version'], 5000)).version ?? null;
    } catch {}
  }
  const selectedPairPath=await realpath(adapterPath).catch(()=>adapterPath);
  const quote=p=>`'${p.replaceAll("'","'\\''")}'`;
  return {discovery:{configuredPath:selected??null,resolvedPath,version,reason,shadowsSelectedPair:resolvedPath!==selectedPairPath},configuration:{plugin:`COVEN_DESKTOP_USE_BIN=${quote(adapterPath)} openclaw gateway`,sdk:{adapterPath},mcp:{adapterPath}},configurationScope:'Current installer process account/environment only; inspect the actual gateway launcher separately.'};
}
async function select(options,trusted) {
  const policy=policyFor(options.version,trusted);verifierPrerequisite();
  return withRoot(options.root,async root=>{
    const {folder,m,receipt}=await loadStaged(root,options.version,policy);const adapterPath=join(folder,'native','coven-desktop-use');const guidance=await inspectBinarySelection(adapterPath);
    let previous=null;try{previous=json(await readRegular(join(root,'active.json'),65536));if(!VERSION.test(previous.releaseVersion))fail('RELEASE_SELECTION_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}
    const selection={schemaVersion:1,releaseVersion:options.version,sourceCommit:m.source.commit,target:receipt.target,manifestSha256:receipt.manifestSha256,previousVersion:previous?.releaseVersion??null,selectedAt:new Date().toISOString()};
    const next=join(root,'.selection-next');await durableJson(next,selection);await rename(next,join(root,'active.json'));
    try{await syncDirectory(root);}catch{const e=new Error('RELEASE_SELECTION_DURABILITY_UNKNOWN');e.releaseState={selectionChanged:true,releaseVersion:options.version,hostSynchronization:'pending'};throw e;}
    return {status:'selected',operation:options.operation??'activate',...selection,adapterPath,packagePath:join(folder,m.package.asset),hostSynchronization:'pending',rollbackLimit:'Selection and versions only; no desktop effects, grants or running hosts are reverted.',...guidance};
  });
}
export const activateRelease=options=>select(options);
export const activateCandidateRelease=(options,trustedPolicy)=>{if(!trustedPolicy)fail('RELEASE_CANDIDATE_POLICY_REQUIRED');return select(options,trustedPolicy);};
if(process.argv[1]&&(await realpath(process.argv[1]).catch(()=>null))===fileURLToPath(import.meta.url)) {
  try {
    const [operation,...args]=process.argv.slice(2);if(!['stage','activate','rollback'].includes(operation))fail('RELEASE_USAGE: stage|activate|rollback --version VERSION --root PRIVATE_ROOT [--manifest FILE --assets DIRECTORY --target TARGET]');
    const options={operation};for(let n=0;n<args.length;n+=2){const key=args[n]?.slice(2);if(!args[n].startsWith('--')||!['version','root',...(operation==='stage'?['manifest','assets','target']:[])].includes(key)||!args[n+1]||args[n+1].startsWith('--')||Object.hasOwn(options,key))fail('RELEASE_ARGUMENT_INVALID');options[key]=args[n+1];}
    if(!options.version||!options.root||(operation==='stage'&&(!options.manifest||!options.assets)))fail('RELEASE_ARGUMENT_REQUIRED');
    console.log(JSON.stringify(await (operation==='stage'?stageRelease(options):activateRelease(options)),null,2));
  } catch(e){console.error(JSON.stringify({error:e.message.startsWith('RELEASE_')?e.message:'RELEASE_INSTALL_FAILED',...(e.releaseState??{selectionChanged:false})}));process.exitCode=1;}
}
