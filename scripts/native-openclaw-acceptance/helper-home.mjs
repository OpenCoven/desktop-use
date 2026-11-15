import { isAbsolute } from 'node:path';

// Foundation does not follow HOME alone when choosing Peekaboo's snapshot cache.
export function nativeHelperHomeEnvironment(home,platform) {
  if(typeof home!=='string'||!isAbsolute(home)||home.includes('\0')||!['darwin','linux'].includes(platform))throw new Error('NATIVE_HELPER_HOME_REJECTED');
  return platform==='darwin'?{HOME:home,CFFIXED_USER_HOME:home}:{};
}
