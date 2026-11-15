import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, lstat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

// Standard-library tar parsing; no extraction, install scripts or desktop helpers.
const inspectTar = `import sys,io,tarfile,hashlib,json,pathlib
raw=sys.stdin.buffer.read(64*1024*1024+1)
assert len(raw)<=64*1024*1024
entries=[];seen=set();total=0
with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as tar:
 for member in tar:
  assert len(entries)<20000
  name=member.name
  assert not name.startswith('/') and '\\\\' not in name and '..' not in pathlib.PurePosixPath(name).parts
  assert member.isdir() or member.isfile()
  if member.isdir(): continue
  assert name.startswith('package/')
  path=name[len('package/'):]
  assert path and path not in seen
  seen.add(path);total+=member.size
  assert member.size<=32*1024*1024 and total<=256*1024*1024
  with tar.extractfile(member) as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
  entries.append({'path':path,'bytes':member.size,'sha256':digest,'executable':bool(member.mode&0o111)})
assert entries
print(json.dumps({'entries':entries,'python':sys.version.split()[0]}))
`;
export async function verifyArchiveFiles(rootPath, archiveBytes) {
  assert.ok(archiveBytes.length <= 64 * 1024 * 1024, 'Bounded packed archive required');
  const result = spawnSync('python3', ['-c', inspectTar], { input: archiveBytes, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  assert.equal(result.status, 0, 'Archive must contain unique safe regular package files');
  const { entries, python } = JSON.parse(result.stdout);
  const root = await realpath(rootPath), expected = new Set(entries.map(entry => entry.path));
  for (const entry of entries) {
    const path = join(root, entry.path), actual = await realpath(path), info = await lstat(path);
    assert.ok(actual.startsWith(root + sep) && info.isFile() && !info.isSymbolicLink(), 'Installed archive files must remain inside selected package');
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes, 'Installed file length must match selected archive');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'Installed file bytes must match selected archive');
    assert.equal(Boolean(info.mode & 0o111), entry.executable, 'Installed file executable mode must match archive');
  }
  async function walk(relative = '') {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (!relative && entry.name === 'node_modules') continue; // Separate installed dependencies.
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else assert.ok(entry.isFile() && expected.has(path), 'Unpacked package must not contain extra executable or metadata files');
    }
  }
  await walk();
  return { files: entries.length, pythonVersion: python, archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'), archiveIntegrity: 'sha512-' + createHash('sha512').update(archiveBytes).digest('base64') };
}
