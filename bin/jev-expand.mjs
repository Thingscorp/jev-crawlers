#!/usr/bin/env node
// jev-expand — follow context cues from one node to child leads.
// Expansion is mechanical only (no model calls):
//   symbol-refs : other files that mention the node's symbol
//   co-change   : files that historically change with the node's file
//   config-ref  : config files that reference the symbol
// Reads one node (or array of nodes) from stdin, writes one child node per
// line (NDJSON). Pipes into jev-judge.
import { readStdinJson, asArray, writeJsonl, fail, readFileSafe } from '../lib/io.mjs';
import { withId } from '../lib/graph.mjs';
import { loadIgnores, grepSymbol, coChangedFiles, configReferences, fileExcerpt } from '../lib/search.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function printVersion() {
  let v = 'unknown';
  try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  console.log(`jev-expand ${v}`);
  process.exit(0);
}

function printHelp() {
  console.log(`usage: jev-expand --repo PATH [--kinds symbol-refs,co-change,config-ref]
                  [--max-children N] [--no-color] [--version] < node.json

Follow context cues from one node (or a JSON array of nodes) to child
leads. Mechanical only — no model calls, no key needed:
  symbol-refs  other files that mention the node's symbol
  co-change    files that historically change with the node's file
  config-ref   config files that reference the symbol

Options:
  --repo PATH        repo under audit (default: current directory)
  --kinds LIST       comma-separated subset of the three kinds above
                     (default: all three)
  --max-children N   cap per input batch (default: 12)
  --no-color         no color output (output is plain text anyway)
  -h, --help         this help
  --version          print version

Reads NDJSON-or-array on stdin; writes one child node per line (NDJSON) —
already machine-readable.

Exit codes: 0 success, 1 runtime error, 2 usage/config error.

Examples:
  jev-seed --repo /path/to/repo --diff | jev-expand --repo /path/to/repo
  echo '{"file":"a.js","symbol":"pay","scope":"pay","depth":0}' \\
    | jev-expand --repo /path/to/repo --kinds symbol-refs`);
  process.exit(0);
}

const args = process.argv.slice(2);
let repo = process.cwd(), kinds = ['symbol-refs', 'co-change', 'config-ref'], maxChildren = 12, noColor = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--repo' && args[i + 1]) repo = args[++i];
  else if (a === '--kinds' && args[i + 1]) kinds = args[++i].split(',');
  else if (a === '--max-children' && args[i + 1]) maxChildren = parseInt(args[++i], 10);
  else if (a === '--no-color') noColor = true;
  else if (a === '--version') printVersion();
  else if (a === '--help' || a === '-h') printHelp();
  else fail(`unknown arg ${a}`, 2);
}

const input = await readStdinJson();
if (!input) process.exit(0); // empty pipe in: empty pipe out
const inputLen = asArray(input).length;
const isIgnored = loadIgnores(repo);
const children = [];
const seen = new Set(); // batch-level dedupe on canonical identity

for (const node of asArray(input)) {
  const depth = (node.depth ?? 0) + 1;

  const emit = (file, symbol, scope, relation, evidence, priority, codeLine, line) => {
    if (!file || isIgnored(file) || file === node.file && symbol === node.symbol && scope === node.scope) return;
    if (children.length >= maxChildren * inputLen) return;
    const id = `${file}::${scope || '<file>'}::${symbol || '?'}`;
    if (seen.has(id)) return;
    seen.add(id);
    const around = Number(line) > 0 ? Number(line) : 1;
    const { excerpt, symbolLine, excerptStartLine } = fileExcerpt(repo, file, around, 30);
    // Structured evidence: the relation as context, plus the concrete code
    // line when the expansion knows it (symbol-refs hits carry file:line).
    const items = [{ kind: 'context', file, line: line || 0, text: `${relation}: ${evidence}`.slice(0, 300) }];
    if (line && codeLine) items.unshift({ kind: 'code', file, line, text: String(codeLine).slice(0, 200) });
    children.push(withId({
      file, symbol: symbol || '?', scope: scope || '<file>',
      kind: 'expanded', depth, priority,
      parent: node.id, relation,
      excerpt, symbolLine, excerptStartLine,
      seed: node.seed,
      evidence: items,
    }));
  };

  // 1. Symbol references: callers and other users of the symbol.
  if (kinds.includes('symbol-refs') && node.symbol && node.symbol !== '?') {
    for (const hit of grepSymbol(repo, node.symbol, isIgnored)) {
      if (hit.file === node.file) continue;
      emit(hit.file, node.symbol, hit.scope,
        'symbol-refs', `${node.symbol} referenced at ${hit.file}:${hit.line}`, 0.8, hit.text, hit.line);
    }
  }

  // 2. Co-change: files that historically change together with this file.
  if (kinds.includes('co-change') && node.file) {
    for (const { file, coChanges } of coChangedFiles(repo, node.file)) {
      if (isIgnored(file)) continue;
      const text = readFileSafe(path.join(repo, file)) || '';
      const m = text.match(/(?:function|def|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
      emit(file, m ? m[1] : '?', m ? m[1] : '<file>', 'co-change',
        `changed together with ${node.file} in ${coChanges} commits`, 0.6);
    }
  }

  // 3. Config references: config files that name the symbol.
  if (kinds.includes('config-ref') && node.symbol && node.symbol !== '?') {
    for (const { file } of configReferences(repo, node.symbol, isIgnored)) {
      emit(file, node.symbol, '<config>', 'config-ref',
        `${file} config references ${node.symbol}`, 0.7);
    }
  }
}

writeJsonl(children.slice(0, maxChildren * inputLen));
