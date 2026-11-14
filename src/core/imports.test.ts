import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { preProcessFile } from 'typescript';

test('standalone client transitive source graph resolves without OpenClaw or MCP runtime imports', async () => {
  const visited = new Set<string>();
  async function visit(file: URL): Promise<void> {
    if (visited.has(file.href)) return; visited.add(file.href);
    for (const entry of preProcessFile(await readFile(file, 'utf8')).importedFiles) {
      const name = entry.fileName;
      if (name.startsWith('node:')) continue;
      assert.ok(name.startsWith('.'), `host-neutral import required: ${file.pathname}: ${name}`);
      await visit(new URL(name.replace(/\.js$/, '.ts'), file));
    }
  }
  await visit(new URL('./client.ts', import.meta.url));
  assert.ok(visited.size > 10, 'checks the complete shared policy/execution graph');
});
