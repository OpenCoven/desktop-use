import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const operationId = value => typeof value === 'string' && /^op-[A-Za-z0-9]+$/.test(value);
const optionalJson = async path => readFile(path, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });

/** Controlled active-helper infrastructure; creates no harness, approval provider or desktop effect. */
export async function createLifecycleFixture({ parentDir = tmpdir(), holdAfterEffect = false } = {}) {
  if (typeof holdAfterEffect !== 'boolean') throw new TypeError('Invalid fixture post-effect hold');
  const parent = await realpath(parentDir);
  const root = await realpath(await mkdtemp(join(parent, 'desktopuse-lifecycle-')));
  try {
    await chmod(root, 0o700);
    await mkdir(join(root, 'operations'), { mode: 0o700 });
    await writeFile(join(root, 'fixture-options.json'), JSON.stringify({ schemaVersion: 1, holdAfterEffect }) + '\n', { mode: 0o600, flag: 'wx' });
    for (const name of ['adapter.cjs', 'helper.cjs']) {
      const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
      await writeFile(join(root, name), `#!${process.execPath}\n${source}`, { mode: 0o700, flag: 'wx' });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  async function directory(id) {
    if (!operationId(id)) throw new TypeError('Invalid fixture operation ID');
    const path = join(root, 'operations', id);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe fixture operation directory');
    return path;
  }
  async function readAudit() {
    let present = true;
    const text = await readFile(join(root, 'events.jsonl'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') { present = false; return ''; }
      throw new Error('Fixture audit unavailable');
    });
    let events;
    try { events = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse); }
    catch { throw new Error('Invalid fixture audit record'); }
    return { present, complete: present && (!text.length || text.endsWith('\n')), events };
  }
  return {
    root,
    adapterPath: join(root, 'adapter.cjs'),
    async readOperations() {
      const result = [];
      for (const id of await readdir(join(root, 'operations'))) {
        if (!operationId(id)) continue;
        const path = await directory(id);
        result.push({ operationId: id, started: await optionalJson(join(path, 'started.json')), active: await optionalJson(join(path, 'active.json')), terminal: await optionalJson(join(path, 'terminal.json')), effectCommitted: await lstat(join(path, 'effect.txt')).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; }) });
      }
      return result;
    },
    readAudit,
    // Phase snapshots may overlap an append. Final evidence must also require readAudit().complete.
    async readEvents() { return (await readAudit()).events; },
    async release(id) { await writeFile(join(await directory(id), 'release'), '', { mode: 0o600, flag: 'wx' }); },
    async finish(id) { await writeFile(join(await directory(id), 'finish'), '', { mode: 0o600, flag: 'wx' }); },
  };
}
