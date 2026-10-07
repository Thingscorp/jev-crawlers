#!/usr/bin/env node
// jev-report — render findings as Markdown and JSON.
// Reads jev-verify output from stdin. Never calls an unverified lead a
// bug. Writes Markdown to stdout (or --out FILE) and JSON to --json FILE
// (or to stdout when --json is bare, instead of Markdown).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, asArray, fail } from '../lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function printVersion() {
  let v = 'unknown';
  try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  console.log(`jev-report ${v}`);
  process.exit(0);
}

function printHelp() {
  console.log(`usage: jev-report [--out report.md] [--json [report.json]] [--stats '{...}']
                  [--no-color] [--version] < verified.json

Render jev-verify findings as Markdown (stdout, or --out FILE) and
optionally as JSON (--json FILE; stdout when bare, in place of Markdown).
Never calls an unverified lead a bug.

Options:
  --out FILE    write the Markdown report to FILE (default: stdout)
  --json [FILE] write findings JSON to FILE; stdout when bare (no Markdown)
  --stats JSON  crawl stats object, rendered as a stats section
  --no-color    no color output (output is plain text anyway)
  -h, --help    this help
  --version     print version

Exit codes: 0 success, 1 runtime error, 2 usage/config error.

Examples:
  jev-verify --repo /path/to/repo < judged.json | jev-report --out report.md
  jev-verify --repo /path/to/repo < judged.json | jev-report --json
  jev-verify --repo /path/to/repo < judged.json | jev-report --json findings.json --out report.md`);
  process.exit(0);
}

const args = process.argv.slice(2);
let outFile = null, jsonFile = null, jsonStdout = false, stats = null, noColor = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out' && args[i + 1]) outFile = args[++i];
  else if (a === '--json' && args[i + 1] && !args[i + 1].startsWith('-')) jsonFile = args[++i];
  else if (a === '--json') jsonStdout = true;
  else if (a === '--stats' && args[i + 1]) stats = JSON.parse(args[++i]);
  else if (a === '--no-color') noColor = true;
  else if (a === '--version') printVersion();
  else if (a === '--help' || a === '-h') printHelp();
  else fail(`unknown arg ${a}`, 2);
}

const input = await readStdinJson();
const findings = asArray(input); // empty stdin: zero findings, still a valid report

if (jsonStdout) {
  process.stdout.write(JSON.stringify(findings, null, 1) + '\n');
  if (outFile) {
    const md = renderMarkdown(findings, stats);
    fs.writeFileSync(outFile, md);
  }
  if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify(findings, null, 1));
  process.exit(0);
}

const md = renderMarkdown(findings, stats);
if (outFile) fs.writeFileSync(outFile, md);
else process.stdout.write(md + '\n');
if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify(findings, null, 1));

function renderMarkdown(findings, stats) {
  const bugs = findings.filter((f) => f.status === 'bug');
  const leads = findings.filter((f) => f.status === 'unverified-lead');
  const escalated = findings.filter((f) => f.status === 'escalated');

  const L = [];
  L.push('# Crawl report');
  L.push('');
  L.push(`Findings: ${bugs.length} bug${bugs.length === 1 ? '' : 's'} (artifact attached, reproducer not executed), ` +
    `${leads.length} unverified lead${leads.length === 1 ? '' : 's'}, ${escalated.length} escalated.`);
  L.push('');
  L.push('> Unverified leads are not bugs. They are leads that did not survive verification.');
  L.push('');

  const renderFinding = (f) => {
    const n = f.node || {};
    const p = f.judgment?.answers?.bug_likely?.probability;
    const conf = f.judgment?.answers?.bug_likely?.confidence;
    const risk = f.judgment?.answers?.risk?.score;
    const lines = [];
    lines.push(`## ${n.file || '?'} :: ${n.symbol || '?'} (${n.scope || '<file>'})`);
    lines.push('');
    lines.push(`- verdict: ${f.judgment?.routing || '?'}${risk != null ? `, risk ${risk}/3 (band)` : ''}${p != null ? `, bug_likely P${p.toFixed(2)} (ranking signal, not calibrated confidence)` : ''}${conf != null ? `, Jev confidence ${conf.toFixed(2)} (vendor-reported, uncalibrated)` : ''}`);
    if (f.fingerprint) lines.push(`- fingerprint: ${f.fingerprint}`);
    lines.push(`- depth: ${n.depth ?? 0}, relation: ${n.relation || n.seed?.type || 'seed'}`);
    if (f.note) lines.push(`- note: ${f.note}`);
    if (f.artifact) {
      lines.push('');
      lines.push('```');
      lines.push(f.artifact.text);
      lines.push('```');
    }
    return lines.join('\n');
  };

  if (bugs.length) {
    L.push('# Bugs (artifact attached, reproducer not executed in v0)');
    L.push('');
    for (const f of bugs) L.push(renderFinding(f), '');
  }
  if (leads.length) {
    L.push('# Unverified leads (not bugs)');
    L.push('');
    for (const f of leads) L.push(renderFinding(f), '');
  }
  if (escalated.length) {
    L.push('# Escalated to a human');
    L.push('');
    for (const f of escalated) L.push(renderFinding(f), '');
  }
  if (stats) {
    L.push('# Crawl stats');
    L.push('');
    L.push(`- nodes visited: ${stats.nodesVisited ?? '?'}`);
    L.push(`- judgments: ${stats.judgments ?? '?'} (Jev calls)`);
    L.push(`- pruned: ${stats.pruned ?? '?'}, expanded: ${stats.expanded ?? '?'}`);
    L.push(`- est. Jev cost: $${(stats.estCostUsd ?? 0).toFixed(5)}`);
    L.push(`- termination: ${stats.termination || '?'}`);
    L.push('');
  }

  return L.join('\n');
}
