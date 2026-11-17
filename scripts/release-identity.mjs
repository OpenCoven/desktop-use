import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
/** Recomputed on every build; an unpacked or dirty checkout is never a verified source. */
export function buildIdentity(releaseVersion) {
  let commit=null,dirty=true;
  try {
    const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    if(realpathSync(root)!==realpathSync(process.cwd()))throw new Error('not the source root');
    commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    if(!/^[a-f0-9]{40}$/.test(commit))commit=null;
    dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()!=='';
  }catch{commit=null;dirty=true;}
  return {schemaVersion:1,releaseVersion,source:{repository:'OpenCoven/desktop-use',commit,dirty},adapterProtocolVersion:1,contracts:{observation:1,capabilities:1,canonicalActions:1}};
}
