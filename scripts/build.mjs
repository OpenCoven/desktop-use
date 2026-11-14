#!/usr/bin/env node
import { rm, mkdir, copyFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await rm('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir('dist/contracts/v1', { recursive: true });
const { name, version, type } = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('dist/package.json', JSON.stringify({ name, version, type }) + '\n');
for (const name of ['observation.schema.json', 'capabilities.schema.json', 'canonical-actions.json', 'canonical-actions.schema.json']) await copyFile(`contracts/v1/${name}`, `dist/contracts/v1/${name}`);
for (const entry of ['src/mcp/main.js', 'examples/approval-host/main.js', 'examples/embedded-client.js']) await chmod(`dist/${entry}`, 0o755);
