import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { COMPUTER_USE_TOOL_NAME } from './tool-names.js';

const guide = new URL('../docs/harnesses.md', import.meta.url);
const main = fileURLToPath(new URL('../dist/src/mcp/main.js', import.meta.url));
const rendererSource = new URL('./mcp/recipes.ts', import.meta.url);

// Independently transcribed from the sixteen immutable PR 51 receipts, checked before writing the guide.
// These historical facts stay pinned when the runner changes; refreshing support requires new receipt identities.
const receiptRoot = 'https://github.com/OpenCoven/desktop-use/blob/20464d48804f8c82b834d5d7b2441a1712989e59/docs/harness-qualification/receipts/';
const recipeSource = 'https://github.com/OpenCoven/desktop-use/blob/381feaa1661261afacbd6f5e3c0226847f9b0d86/src/mcp/recipes.ts';
type Verdict = 'pass' | 'fail' | 'unqualified';
type ReceiptFact = { harness: string; platform: string; variant: string; L1: Verdict; L2: Verdict; image: 'delivered' | 'dropped' | null };
const receiptFacts = new Map<string, ReceiptFact>([
  ['darwin-arm64/pr50-claude-code-default.json', { harness: 'claude', platform: 'macOS', variant: 'default', L1: 'pass', L2: 'pass', image: 'delivered' }],
  ['darwin-arm64/pr50-codex-default.json', { harness: 'codex', platform: 'macOS', variant: 'default', L1: 'pass', L2: 'fail', image: 'dropped' }],
  ['darwin-arm64/pr50-codex-tool-search.json', { harness: 'codex', platform: 'macOS', variant: 'tool-search', L1: 'pass', L2: 'pass', image: 'dropped' }],
  ['darwin-arm64/pr50-copilot-default.json', { harness: 'copilot', platform: 'macOS', variant: 'default', L1: 'pass', L2: 'fail', image: 'dropped' }],
  ['darwin-arm64/pr50-copilot-vision.json', { harness: 'copilot', platform: 'macOS', variant: 'vision', L1: 'pass', L2: 'fail', image: 'delivered' }],
  ['darwin-arm64/any-opencode-default.json', { harness: 'opencode', platform: 'macOS', variant: 'default', L1: 'unqualified', L2: 'unqualified', image: null }],
  ['darwin-arm64/any-hermes-default.json', { harness: 'hermes', platform: 'macOS', variant: 'default', L1: 'unqualified', L2: 'unqualified', image: null }],
  ['darwin-arm64/pr50-coven-code-default.json', { harness: 'coven-code', platform: 'macOS', variant: 'default', L1: 'fail', L2: 'fail', image: null }],
  ['linux-x64-ci/claude-code-default.json', { harness: 'claude', platform: 'Linux', variant: 'default', L1: 'fail', L2: 'fail', image: null }],
  ['linux-x64-ci/codex-default.json', { harness: 'codex', platform: 'Linux', variant: 'default', L1: 'pass', L2: 'fail', image: 'dropped' }],
  ['linux-x64-ci/codex-tool-search.json', { harness: 'codex', platform: 'Linux', variant: 'tool-search', L1: 'pass', L2: 'pass', image: 'dropped' }],
  ['linux-x64-ci/copilot-default.json', { harness: 'copilot', platform: 'Linux', variant: 'default', L1: 'pass', L2: 'fail', image: 'dropped' }],
  ['linux-x64-ci/copilot-vision.json', { harness: 'copilot', platform: 'Linux', variant: 'vision', L1: 'pass', L2: 'fail', image: 'delivered' }],
  ['linux-x64-ci/opencode-default.json', { harness: 'opencode', platform: 'Linux', variant: 'default', L1: 'unqualified', L2: 'unqualified', image: null }],
  ['linux-x64-ci/hermes-default.json', { harness: 'hermes', platform: 'Linux', variant: 'default', L1: 'unqualified', L2: 'unqualified', image: null }],
  ['linux-x64-ci/coven-code-default.json', { harness: 'coven-code', platform: 'Linux', variant: 'default', L1: 'unqualified', L2: 'unqualified', image: null }],
].map(([path, fact]) => [receiptRoot + path, fact]) as [string, ReceiptFact][]);

// Hand-checked corrected PR 53 receipts from run 43826298788; these qualify only the unlanded candidate.
const candidateReceiptRoot = 'https://github.com/OpenCoven/desktop-use/blob/6a78069b6dcb968b1a80fa6f003135cc83340e30/docs/harness-qualification/receipts/';
const candidateFacts = new Map([
  ['claude:macOS:default', 'darwin-arm64-ci/pr53-claude-code-default.json', 'delivered'],
  ['codex:macOS:default', 'darwin-arm64-ci/pr53-codex-default.json', 'dropped'],
  ['codex:macOS:tool-search', 'darwin-arm64-ci/pr53-codex-tool-search.json', 'dropped'],
  ['copilot:macOS:default', 'darwin-arm64-ci/pr53-copilot-default.json', 'dropped'],
  ['copilot:macOS:vision', 'darwin-arm64-ci/pr53-copilot-vision.json', 'delivered'],
  ['claude:Linux:default', 'linux-x64-ci/pr53-claude-code-default.json', 'delivered'],
  ['codex:Linux:default', 'linux-x64-ci/pr53-codex-default.json', 'dropped'],
  ['codex:Linux:tool-search', 'linux-x64-ci/pr53-codex-tool-search.json', 'dropped'],
  ['copilot:Linux:default', 'linux-x64-ci/pr53-copilot-default.json', 'dropped'],
  ['copilot:Linux:vision', 'linux-x64-ci/pr53-copilot-vision.json', 'delivered'],
].map(([key, path, image]) => [key, { url: candidateReceiptRoot + path, image }]));

// Reject duplicate labels before resolving links, including Markdown's case/whitespace aliases.
function evidenceReferences(markdown: string): Map<string, string> {
  const references = new Map<string, string>();
  for (const definition of markdown.matchAll(/^ {0,3}\[([^\]]+)\]:([^\n]*)$/gm)) {
    const label = definition[1].trim().replace(/\s+/g, ' ').toLowerCase();
    assert.ok(!references.has(label), `Duplicate reference label: ${label}`);
    references.set(label, definition[2].trim());
  }
  return references;
}

function assertRecipeCoverage(markdown: string, advertised: string[], rendererIds: string[]) {
  const ids = [...rendererIds].sort();
  assert.deepEqual([...advertised].sort(), ids, 'CLI help must cover the authoritative renderer registry');
  const registry = markdown.split('<!-- harness-registry:start -->')[1]?.split('<!-- harness-registry:end -->')[0];
  assert.ok(registry, 'The guide must contain its harness registry');
  const rows = [...registry.matchAll(/^\| `([a-z-]+)` \|/gm)].map(row => row[1]).sort();
  assert.deepEqual(rows, ids, 'The matrix must contain every renderer recipe exactly once');
  const sections = [...markdown.matchAll(/^### Recipe: `([a-z-]+)`$/gm)].map(section => section[1]).sort();
  assert.deepEqual(sections, ids, 'Every renderer recipe must have exactly one operator section');
  return { ids, registry };
}

// Read the actual registration data without exporting or changing the independently owned runtime module.
function rendererIds(source: string): string[] {
  const arrays: ts.ArrayLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'harnesses' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) arrays.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('recipes.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  assert.equal(arrays.length, 1, 'The authoritative recipe registry must be readable');
  return arrays[0].elements.map(element => {
    assert.ok(ts.isObjectLiteralExpression(element), 'A recipe registration must have explicit metadata');
    const property = element.properties.find(item => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === 'id');
    assert.ok(property && ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer), 'A recipe registration must have a literal ID');
    return property.initializer.text;
  });
}

// A new working renderer recipe must update both CLI help and the guide; agreement between two stale lists is insufficient.
test('every advertised recipe has exactly one support row and an executable recipe section', async () => {
  const markdown = await readFile(guide, 'utf8').catch(() => '');
  assert.ok(markdown.length > 0, 'The packaged harness guide must exist');
  const help = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  const advertised = /Harness ids: ([^.]+)\./.exec(help.stderr);
  assert.ok(advertised, 'Recipe help must advertise its harness IDs');
  const { ids, registry } = assertRecipeCoverage(markdown, advertised[1].split(',').map(id => id.trim()), rendererIds(await readFile(rendererSource, 'utf8')));
  for (const id of ids) {
    const section = markdown.split(`### Recipe: \`${id}\``)[1].split(/^### /m)[0];
    assert.ok(section.includes(`coven-desktop-use-mcp recipe --harness ${id}\n`), `${id} section must give the print-only command`);
    const result = spawnSync(process.execPath, [main, 'recipe', '--harness', id], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const recipe = JSON.parse(result.stdout);
    assert.equal(recipe.harness, id);
    assert.equal(recipe.evidence.realHarness, false);
    assert.equal(recipe.evidence.nativeDesktop, false);
    const row = registry.split('\n').find(line => line.startsWith(`| \`${id}\` |`))!;
    assert.ok(row.includes(recipe.evidence.version ?? 'Unpinned'), `${id} row must name the recipe's checked version`);
    if (recipe.qualification === 'unqualified') assert.match(row, /unqualified/i);
  }
});

test('matching stale help and guide IDs cannot hide an extra renderer recipe', async () => {
  const markdown = await readFile(guide, 'utf8');
  const source = await readFile(rendererSource, 'utf8');
  const registration = { id: 'new-harness', version: null, format: 'json', target: 'example.json', sources: [], toolName: COMPUTER_USE_TOOL_NAME };
  const mutation = source.replace('const harnesses: RecipeHarness[] = [', `const harnesses: RecipeHarness[] = [\n  ${JSON.stringify(registration)},`);
  assert.notEqual(mutation, source);
  assert.ok(rendererIds(mutation).includes('new-harness'));
  assert.throws(() => assertRecipeCoverage(markdown, rendererIds(source), rendererIds(mutation)), /authoritative renderer registry/);
});

function assertSupportMatrix(markdown: string) {
  const matrix = markdown.split('<!-- harness-matrix:start -->')[1]?.split('<!-- harness-matrix:end -->')[0];
  assert.ok(matrix, 'The guide must contain its platform support matrix');
  const headers = matrix.split('\n').filter(line => line.startsWith('|') && !/^\| `/.test(line) && !/^\|[-:|\s]+$/.test(line));
  assert.ok(headers.length > 0, 'The matrix must have a support header');
  for (const header of headers) assert.deepEqual(header.split('|').slice(1, -1).map(cell => cell.trim()), ['Recipe ID', 'Platform', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'Image'], 'Unsupported support matrix header');
  const rows = matrix.split('\n').filter(line => /^\| `/.test(line));
  const registry = markdown.split('<!-- harness-registry:start -->')[1]?.split('<!-- harness-registry:end -->')[0] ?? '';
  const ids = [...registry.matchAll(/^\| `([a-z-]+)` \|/gm)].map(row => row[1]);
  const expected = ids.flatMap(id => [`${id}:macOS`, `${id}:Linux`]).sort();
  const observed: string[] = [];
  const references = evidenceReferences(markdown);
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(cells.length, 9, 'Matrix columns are ID, platform, L0 through L5, image');
    observed.push(`${cells[0].replaceAll('`', '')}:${cells[1]}`);
    const id = cells[0].replaceAll('`', '');
    for (let column = 2; column < cells.length; column++) {
      const cell = cells[column];
      if (/^Unverified$/i.test(cell)) continue;
      const pattern = /\[([^\]]+)\](?:\((https:\/\/[^)]+)\)|\[([a-z0-9-]+)\])/g;
      const claims = [...cell.matchAll(pattern)];
      assert.ok(claims.length > 0 && !cell.replace(pattern, '').replace(/[;\s]/g, ''), `Unsupported matrix claim: ${cell}`);
      for (const claim of claims) {
        const url = claim[2] ?? references.get(claim[3]);
        const label = claim[1].toLowerCase();
        if (column === 2) {
          assert.equal(url, recipeSource, 'Evidence for L0 must be the pinned recipe source');
          const expected = id === 'generic' ? 'example; unqualified' : ['grok', 'gemini', 'cursor'].includes(id) ? 'template; unqualified' : 'recipe only';
          assert.equal(label, expected, 'Evidence supports only the source-checked recipe status');
          continue;
        }
        const fact = receiptFacts.get(url ?? '');
        assert.ok(fact, `Evidence is not a qualified receipt: ${cell}`);
        assert.equal(fact.harness, id, 'Evidence belongs to a different harness');
        assert.equal(fact.platform, cells[1], 'Evidence belongs to a different platform');
        const parsed = /^([a-z]+)(?:, (byte identical)|: ([a-z0-9 -]+))?$/.exec(label);
        assert.ok(parsed, `Unsupported evidence assertion: ${label}`);
        const [, state, identical, annotation] = parsed;
        if (annotation && ['default', 'tool-search', 'vision'].includes(annotation)) assert.equal(annotation, fact.variant, 'Evidence belongs to a different variant');
        else if (annotation) {
          const notes: Record<string, boolean> = {
            'health spilled': column === 4 && id === 'copilot' && fact.L2 === 'fail',
            'no runner recipe': column === 3 && ['opencode', 'hermes'].includes(id) && fact.L1 === 'unqualified',
            'mcp server not started': column === 3 && id === 'coven-code' && fact.L1 === 'fail',
            'binary not found': column === 3 && id === 'coven-code' && fact.platform === 'Linux' && fact.L1 === 'unqualified',
            'schema rejected': column === 3 && id === 'claude' && fact.platform === 'Linux' && fact.L1 === 'fail',
          };
          assert.equal(notes[annotation], true, `Unsupported evidence annotation: ${annotation}`);
        }
        if (column === 8) {
          assert.ok(!identical || fact.image === 'delivered', 'Evidence does not establish byte-identical image delivery');
          assert.equal(state, fact.image, 'Evidence contradicts the image delivery claim');
        } else {
          assert.ok(!identical, 'Unsupported byte-identical claim on a support level');
          const level = column === 3 ? 'L1' : column === 4 ? 'L2' : null;
          assert.ok(level, 'Evidence does not qualify L3, L4 or L5');
          assert.equal(state, fact[level], 'Evidence contradicts the support level verdict');
        }
      }
    }
  }
  assert.deepEqual(observed.sort(), expected, 'Each recipe needs exactly one row for each platform');
}

test('each platform support cell links its evidence or explicitly says unverified', async () => {
  assertSupportMatrix(await readFile(guide, 'utf8'));
});

function changeCell(markdown: string, id: string, platform: string, index: number, value: string) {
  return markdown.split('\n').map(line => {
    if (!line.startsWith(`| \`${id}\` | ${platform} |`)) return line;
    const cells = line.split('|'); cells[index + 1] = ` ${value} `; return cells.join('|');
  }).join('\n');
}

for (const [name, id, platform, column, cell] of [
  ['contradictory level verdict', 'copilot', 'macOS', 4, '[Pass][mac-copilot]'],
  ['contradictory image delivery', 'codex', 'macOS', 8, '[Delivered][mac-codex-search]'],
  ['native claim from recipe evidence', 'claude', 'macOS', 7, '[Pass][recipes]'],
  ['wrong platform evidence', 'claude', 'macOS', 3, '[Pass][linux-claude]'],
  ['wrong harness evidence', 'claude', 'macOS', 3, '[Pass][mac-codex]'],
  ['wrong variant evidence', 'copilot', 'macOS', 8, '[Delivered: default][mac-copilot-vision]'],
  ['unsupported extra assertion', 'claude', 'macOS', 3, '[Pass][mac-claude] and native pass'],
] as const) test(`matrix rejects ${name}`, async () => {
  const markdown = await readFile(guide, 'utf8');
  const mutation = changeCell(markdown, id, platform, column, cell);
  assert.notEqual(mutation, markdown);
  assert.throws(() => assertSupportMatrix(mutation), /Evidence|Unsupported/);
});

for (const replacement of ['L1 | L5 | L3 | L4 | L5', 'L1 | L5 | L3 | L4 | L2']) test(`matrix rejects relabeled support header ${replacement}`, async () => {
  const markdown = await readFile(guide, 'utf8');
  const mutation = markdown.replace('L1 | L2 | L3 | L4 | L5', replacement);
  assert.notEqual(mutation, markdown);
  assert.throws(() => assertSupportMatrix(mutation), /header/);
});

function assertCandidateMatrix(markdown: string) {
  const matrix = markdown.split('<!-- harness-candidate-matrix:start -->')[1]?.split('<!-- harness-candidate-matrix:end -->')[0];
  assert.ok(matrix, 'The guide must distinguish corrected candidate evidence from historical evidence');
  const lines = matrix.split('\n').filter(line => line.startsWith('|'));
  assert.deepEqual(lines[0].split('|').slice(1, -1).map(cell => cell.trim()), ['Recipe ID', 'Platform', 'Variant', 'L1', 'L2', 'L3', 'L4', 'L5', 'Image'], 'Unsupported candidate matrix header');
  const references = evidenceReferences(markdown);
  const observed: string[] = [];
  for (const line of lines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(cells.length, 9, 'Candidate rows must keep support levels separate from image delivery');
    const key = `${cells[0].replaceAll('`', '')}:${cells[1]}:${cells[2]}`;
    observed.push(key);
    const fact = candidateFacts.get(key);
    assert.ok(fact, 'Evidence belongs to an unsupported candidate harness/platform/variant');
    for (const column of [3, 4, 8]) {
      const claim = /^\[([^\]]+)\]\[([a-z0-9-]+)\]$/.exec(cells[column]);
      assert.ok(claim, 'Candidate claims must link exactly one immutable receipt');
      assert.equal(references.get(claim[2]), fact.url, 'Evidence belongs to a different candidate harness/platform/variant');
      assert.equal(claim[1], column === 8 ? fact.image === 'delivered' ? 'Delivered, byte identical' : 'Dropped' : 'Pass', 'Evidence contradicts the candidate verdict or image delivery');
    }
    assert.deepEqual(cells.slice(5, 8), ['Unverified', 'Unverified', 'Unverified'], 'Candidate L1/L2 receipts do not qualify L3, L4 or L5');
  }
  assert.deepEqual(observed.sort(), [...candidateFacts.keys()].sort(), 'Every corrected candidate variant needs one row per platform');
}

test('corrected candidate support claims preserve receipt scope and image delivery', async () => {
  assertCandidateMatrix(await readFile(guide, 'utf8'));
});

for (const [name, before, after] of [
  ['wrong platform', '[Pass][candidate-mac-claude]', '[Pass][candidate-linux-claude]'],
  ['wrong variant', '[Pass][candidate-mac-codex]', '[Pass][candidate-mac-codex-search]'],
  ['contradictory verdict', '[Pass][candidate-mac-codex]', '[Fail][candidate-mac-codex]'],
  ['contradictory image', '[Dropped][candidate-mac-codex]', '[Delivered, byte identical][candidate-mac-codex]'],
  ['historical evidence', '[Pass][candidate-linux-claude]', '[Pass][linux-claude]'],
] as const) test(`candidate matrix rejects ${name}`, async () => {
  const markdown = await readFile(guide, 'utf8');
  const mutation = markdown.replace(before, after);
  assert.notEqual(mutation, markdown);
  assert.throws(() => assertCandidateMatrix(mutation), /Evidence/);
});

for (const column of [5, 6, 7]) test(`candidate observations cannot qualify support column ${column}`, async () => {
  const markdown = await readFile(guide, 'utf8');
  const marker = '<!-- harness-candidate-matrix:start -->';
  const [historical, candidate] = markdown.split(marker);
  assert.ok(candidate, 'Candidate matrix must exist');
  const mutation = historical + marker + candidate.split('\n').map(line => {
    if (!line.startsWith('| `claude` | macOS | default |')) return line;
    const cells = line.split('|'); cells[column + 1] = ' [Pass][candidate-mac-claude] '; return cells.join('|');
  }).join('\n');
  assert.notEqual(mutation, markdown);
  assert.throws(() => assertCandidateMatrix(mutation), /do not qualify/);
});

for (const label of ['candidate-mac-claude', 'CANDIDATE-MAC-CLAUDE']) test(`candidate matrix rejects duplicate Markdown evidence label ${label}`, async () => {
  const markdown = await readFile(guide, 'utf8');
  const mutation = `   [${label}]: http://example.invalid/wrong-receipt\n\n${markdown}`;
  assert.throws(() => assertCandidateMatrix(mutation), /duplicate reference/i);
});

test('corrected candidate receipts cannot replace dated historical evidence', async () => {
  const markdown = await readFile(guide, 'utf8');
  const mutation = changeCell(markdown, 'claude', 'Linux', 3, '[Pass][candidate-linux-claude]');
  assert.notEqual(mutation, markdown);
  assert.throws(() => assertSupportMatrix(mutation), /Evidence/);
});

test('the actual production tarball contains the harness guide unchanged', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktopuse-guide-pack37-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), npm_config_update_notifier: 'false' },
  });
  assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout);
  assert.ok(packed.files.some((file: { path: string }) => file.path === 'docs/harnesses.md'), 'The support guide must ship with the package');
  const extracted = spawnSync('tar', ['-xOf', join(root, packed.filename), 'package/docs/harnesses.md'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.equal(extracted.stdout, await readFile(guide, 'utf8'));
});
