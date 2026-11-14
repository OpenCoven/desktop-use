#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const root = resolve(option('--root') ?? process.cwd());
const compiled = args.includes('--compiled');
const prefix = compiled ? 'dist/' : '';
const extension = compiled ? 'js' : 'ts';
const graphs = {
  plugin: { entries: [`index.${extension}`], allowed: name => ['openclaw/plugin-sdk/plugin-entry', 'openclaw/plugin-sdk/state-paths'].includes(name) },
  core: { entries: [`src/sdk.${extension}`], allowed: () => false },
  contracts: { entries: [`src/contracts.${extension}`], allowed: () => false },
  connector: { entries: [`src/mcp/main.${extension}`, `examples/approval-host/main.${extension}`, `examples/embedded-client.${extension}`], allowed: name => ['@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio', 'ajv/dist/2020.js'].includes(name) },
};
const failures = [];
let total = 0;
for (const [graph, config] of Object.entries(graphs)) {
  if (option('--graph') && option('--graph') !== graph) continue;
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return; visited.add(file); total++;
    if (!existsSync(file)) { failures.push(`${graph}: missing runtime file ${relative(root, file)}`); return; }
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const fail = message => failures.push(`${graph}: ${relative(root, file)}: ${message}`);
    function dependency(name) {
      if (name.startsWith('node:')) { if (name === 'node:module') fail('unsupported runtime module loader'); return; }
      if (!name.startsWith('.')) { if (!config.allowed(name)) fail(`unsupported runtime import "${name}"`); return; }
      let target = resolve(dirname(file), name);
      if (!compiled) target = target.replace(/\.js$/, '.ts');
      if (!target.startsWith(root + '/')) { fail(`unsupported runtime path "${name}"`); return; }
      if (graph !== 'connector' && /\/(?:mcp|examples)\//.test(relative(root, target).replace(/^/, '/'))) { fail(`unsupported runtime connector boundary "${name}"`); return; }
      visit(target);
    }
    function walk(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const typesOnly = clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly));
        if (!typesOnly) dependency(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0 || !node.exportClause.elements.every(element => element.isTypeOnly)) dependency(node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteralLike(expression)) dependency(expression.text); else fail('nonliteral runtime import');
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const argument = node.arguments[0];
        if (node.arguments.length === 1 && ts.isStringLiteralLike(argument)) dependency(argument.text); else fail('nonliteral runtime import');
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  for (const entry of config.entries) visit(resolve(root, prefix + entry));
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${total} transitive ${compiled ? 'compiled' : 'source'} runtime files across ${option('--graph') ?? 'plugin/core/contracts/connector'} graphs.`);
