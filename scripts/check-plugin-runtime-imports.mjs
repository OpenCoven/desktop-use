#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = ['index.ts', 'src/plugin-tool.ts'];
const allowedBarePrefixes = ['node:', 'openclaw/'];
const importPattern = /(?:^|\n)\s*import(?:\s+type)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const failures = [];

for (const file of files) {
  const text = readFileSync(join(process.cwd(), file), 'utf8');
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const isAllowedBare = allowedBarePrefixes.some((prefix) => specifier.startsWith(prefix));
    if (!isRelative && !isAllowedBare) {
      failures.push(`${file}: unsupported runtime import "${specifier}"`);
    }
  }
}

if (failures.length > 0) {
  console.error('Plugin runtime imports must stay self-contained.');
  console.error('Allowed imports: relative files, node:* built-ins, and openclaw/* host APIs.');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} plugin runtime file(s); no external runtime imports found.`);
