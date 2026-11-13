import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const guard = new URL('./check-plugin-runtime-imports.mjs', import.meta.url);
for (const [name, source] of Object.entries({
  emptyImport: "import {} from 'private-host-runtime';",
  emptyExport: "export {} from 'private-host-runtime';",
  transitive: "export { value } from 'private-host-runtime';",
  dynamic: "export const value = import('@modelcontextprotocol/server');",
  require: "export const value = require('openclaw/internal');",
  computed: "export const value = import(process.env.MODULE);",
})) test(`core rejects ${name} runtime dependency`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'graph24-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/core'), { recursive: true });
  await writeFile(join(root, 'src/sdk.ts'), "export * from './core/client.js';");
  await writeFile(join(root, 'src/core/client.ts'), "export { value } from './nested.js';");
  await writeFile(join(root, 'src/core/nested.ts'), source);
  const result = spawnSync(process.execPath, [guard.pathname, '--root', root, '--graph', 'core'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /src\/core\/nested.ts/); assert.match(result.stderr, /unsupported runtime|nonliteral runtime/);
});
test('type-only imports do not impose runtime dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graph24-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/core'), { recursive: true });
  await writeFile(join(root, 'src/sdk.ts'), "export * from './core/client.js';");
  await writeFile(join(root, 'src/core/client.ts'), "import type { Host } from 'openclaw'; export type { Host }; export type { Other } from '@modelcontextprotocol/server';");
  const result = spawnSync(process.execPath, [guard.pathname, '--root', root, '--graph', 'core'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
