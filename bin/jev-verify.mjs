#!/usr/bin/env node
// jev-verify — separate verifier step between judge and report.
//
// STANDALONE: this tool is a dependency-light gate for ANY Jev pipeline,
// not just the crawler. Pipe { node, judgment } records in (NDJSON or a
// JSON array) and it writes findings out, one per line. It needs only
// node >= 20 and lib/io.mjs; it makes no Jev calls and holds no key.
// Example: some-other-pipeline | node bin/jev-verify --repo /path/to/code
//
// The judge can only say "this looks like a bug". The verifier assembles a
// falsifiable artifact for each report candidate and checks that it is
// grounded against three things:
//   (a) the judge's stated artifact — the verdict choice ('report' means the
//       judge named a concrete bug; 'escalate' means a possible serious one)
//       plus artifact_stated, kept as a ranking signal for the reviewer;
//   (b) the node's full evidence, including seed evidence — structured
//       items of kind code/pattern/diff/context that cite file:line — plus
//       the driver-attached locations (judgment.attachedEvidence, see
//       lib/evidence.mjs): the node's own cited code locations, attached to
//       the judgment record before verification runs. The union is what the
//       verifier grounds against; the on-disk check still applies to every
//       location, and a fabricated citation demotes by itself.
//   (c) the actual file on disk — the verifier reads every cited file:line
//       and confirms it exists with matching content. A cited location that
//       does not exist on disk demotes by itself (fail-closed against
//       fabricated evidence). The on-disk check is the strongest grounding
//       signal and is what makes "verified bug" reachable.
//
// Anything that fails the check is demoted to an "unverified lead" and is
// never called a bug. artifact_stated never demotes alone: it only adds a
// reason when the claim is already weak on another ground.
//
// v0 verification is artifact grounding, not execution: the verifier cannot
// run the reproducer, and it does not re-derive the bug from the code — it
// confirms the claim cites real code. Running reproducers is on the
// roadmap. The report labels this honestly.
//
// Reads { node, judgment } records from stdin (NDJSON or a JSON array).
// Writes findings, one per line (NDJSON):
//   { node, judgment, status: "bug" | "unverified-lead" | "escalated",
//     artifact: { kind, text } | null }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, asArray, writeJsonl, fail, readFileSafe } from '../lib/io.mjs';
import { findingFingerprint } from '../lib/fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function printVersion() {
  let v = 'unknown';
  try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  console.log(`jev-verify ${v}`);
  process.exit(0);
}

function printHelp() {
  console.log(`usage: jev-verify [--risk-floor 1] [--repo PATH] [--no-color] [--version] < judged.json

Dependency-light gate for any Jev pipeline: pipe { node, judgment }
records in (NDJSON or a JSON array), get findings out, one per line
(NDJSON) — already machine-readable. Needs only node >= 20 and
lib/io.mjs — no Jev calls, no key.

The verifier builds a falsifiable artifact per report candidate and
checks it is grounded: every cited file:line must exist on disk with
matching content. A fabricated or missing citation demotes the finding
to an unverified lead — never a bug.

Options:
  --risk-floor F   minimum risk score to verify (default: 1)
  --repo PATH      repo to ground citations against (default: cwd)
  --no-color       no color output (output is plain text anyway)
  -h, --help       this help
  --version        print version

Output statuses: bug | unverified-lead | escalated. Escalated routings
(escalate-owner, needs-artifact, review-queue) pass through untouched;
expand/prune routings are not findings and produce no output.

Exit codes: 0 success, 1 runtime error, 2 usage/config error.

Examples:
  jev-seed --repo /path/to/repo --diff | jev-judge | jev-verify --repo /path/to/repo
  some-other-pipeline --format ndjson | jev-verify --repo /path/to/code --risk-floor 2`);
  process.exit(0);
}

const args = process.argv.slice(2);
let riskFloor = 1, repo = process.cwd(), noColor = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--risk-floor' && args[i + 1]) riskFloor = parseFloat(args[++i]);
  else if (a === '--repo' && args[i + 1]) repo = args[++i];
  else if (a === '--no-color') noColor = true;
  else if (a === '--version') printVersion();
  else if (a === '--help' || a === '-h') printHelp();
  else fail(`unknown arg ${a}`, 2);
}

const input = await readStdinJson();
if (!input) process.exit(0); // empty pipe in: empty pipe out

const findings = [];
for (const { node, judgment } of asArray(input)) {
  const routing = judgment?.routing || 'review-queue';
  // Stable finding identity (spec §18): same claim -> same fingerprint
  // across runs, regardless of verification outcome. Computed from the
  // claim only (verdict class, primary location, evidence path).
  const fingerprint = findingFingerprint({ node, judgment }, repo);
  if (routing === 'escalate-owner' || routing === 'needs-artifact' || routing === 'review-queue') {
    findings.push({ node, judgment, status: 'escalated', artifact: null, fingerprint,
      note: routing === 'needs-artifact'
        ? 'judge saw a bug but the case is not falsifiable; human decides'
        : routing === 'review-queue'
          ? 'uncertain or weak signal; human triages (review queue is the primary sink)'
          : 'serious blast radius or ambiguous evidence; human decides' });
    continue;
  }
  if (routing !== 'file-report') continue; // expand/prune verdicts are not findings

  const risk = judgment.answers?.risk?.score ?? 0;
  const reasons = [];
  if (risk < riskFloor) reasons.push(`risk score ${risk} below floor ${riskFloor} (ranking band, not a bug probability)`);
  const items = evidenceItems(node, judgment);
  const locs = citedLocations(node, items);
  // Evidence items that cite code: each must exist on disk. A fabricated
  // citation demotes by itself. The node's own symbol line can only add
  // confirmation, never a gap.
  const itemChecks = locs.evidence.map((l) => ({ ...l, check: checkOnDisk(repo, l) }));
  const symbolCheck = locs.symbolLine ? checkOnDisk(repo, locs.symbolLine) : { ok: false };
  const confirmed = [
    ...itemChecks.filter((c) => c.check.ok),
    ...(symbolCheck.ok ? [{ ...locs.symbolLine }] : []),
  ];
  const failedItems = itemChecks.filter((c) => !c.check.ok);
  const artifact = assembleArtifact(node, judgment, items, confirmed);
  if (!artifact) reasons.push('no grounded artifact could be assembled');
  else {
    const gaps = groundedGaps(judgment, locs.evidence, failedItems, confirmed);
    if (gaps.length) reasons.push(...gaps);
  }

  if (reasons.length) {
    findings.push({ node, judgment, status: 'unverified-lead', artifact: artifact || null, fingerprint,
      note: 'demoted: ' + reasons.join('; ') });
  } else {
    findings.push({ node, judgment, status: 'bug', artifact, fingerprint,
      note: `artifact grounded: claim cites ${confirmed.length} on-disk code location(s); reproducer not executed (v0)` });
  }
}

// Normalize evidence: structured items pass through, legacy strings become
// context items, the seed's evidence is included (seeds carry real
// evidence since the structured-evidence fix), and the driver-attached
// locations ride along on the judgment record.
function evidenceItems(node, judgment) {
  const items = [];
  for (const e of (node.evidence || [])) {
    if (typeof e === 'string') items.push({ kind: 'context', text: e });
    else if (e && typeof e === 'object') items.push(e);
  }
  if (node.seed && node.seed.evidence) {
    items.push({ kind: 'context', text: `seed(${node.seed.type}): ${node.seed.evidence}` });
  }
  for (const e of (judgment?.attachedEvidence || [])) {
    if (e && typeof e === 'object' && e.file && e.line) {
      items.push({ kind: e.kind || 'code', file: e.file, line: e.line, text: e.text || '' });
    }
  }
  return items;
}

// Code locations the claim cites: code/pattern evidence items with
// file:line, plus the node's own symbol line (fallback only).
// Returns { evidence: [...], symbolLine: {...} | null }. Deduplicated.
function citedLocations(node, items) {
  const seen = new Set(), evidence = [];
  const add = (file, line, text) => {
    if (!file || !line) return;
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ file, line, text: text || '' });
  };
  for (const it of items) {
    if ((it.kind === 'code' || it.kind === 'pattern') && it.file && it.line) {
      add(it.file, it.line, it.text);
    }
  }
  let symbolLine = null;
  if (node.file && node.symbolLine) symbolLine = { file: node.file, line: node.symbolLine, text: '' };
  return { evidence, symbolLine };
}

// The strongest grounding signal: the cited file:line exists on disk and,
// when the evidence cites text, the on-disk line matches it.
function checkOnDisk(repoDir, loc) {
  const text = readFileSafe(path.join(repoDir, loc.file));
  if (text == null) return { ok: false, reason: `file not found on disk: ${loc.file}` };
  if (text.length === 0) {
    return { ok: false, reason: `${loc.file}:${loc.line} out of range (empty file)` };
  }
  const lines = text.split('\n');
  if (loc.line < 1 || loc.line > lines.length) {
    return { ok: false, reason: `${loc.file}:${loc.line} out of range (${lines.length} lines)` };
  }
  const actual = lines[loc.line - 1].trim();
  const cited = String(loc.text || '').trim().slice(0, 200);
  // Guard the empty-line edge: a file ending with '\n' splits into a
  // phantom trailing '' line, and `cited.includes('')` is always true —
  // so a fabricated cite on that line must not get a vacuous pass.
  if (cited && !actual.includes(cited) && !(actual && cited.includes(actual))) {
    return { ok: false, reason: `${loc.file}:${loc.line} content mismatch` };
  }
  return { ok: true, actual };
}

// Build the falsifiable artifact from the node's concrete evidence,
// including the judge's stated artifact and the on-disk confirmation.
function assembleArtifact(node, judgment, items, confirmed) {
  const verdict = judgment?.answers?.verdict?.choice || '?';
  const aStated = judgment?.answers?.artifact_stated?.probability;
  const excerpt = (node.excerpt || '').trim();
  if (!node.file || !excerpt) return null;
  const lines = [
    `REPRODUCER SKETCH for ${node.file} :: ${node.scope || '<file>'} :: ${node.symbol || '?'}`,
    `judge's stated artifact: verdict=${verdict}` +
      (aStated != null ? `, artifact_stated P=${aStated} (ranking signal, not calibrated confidence)` : ''),
    `on-disk confirmation: ${confirmed.length} cited location(s) exist in the repo: ` +
      (confirmed.map((c) => `${c.file}:${c.line}`).join(', ') || 'none'),
    'evidence:',
    ...items.slice(0, 8).map((e) => `  - [${e.kind || 'evidence'}]${e.file ? ' ' + e.file + (e.line ? ':' + e.line : '') : ''} ${String(e.text || '').slice(0, 300)}`.trimEnd()),
    'code under test:',
    ...excerpt.split('\n').slice(0, 25).map((l) => `  | ${l}`),
    'to falsify: run the sketch above against the code; if the stated wrong behavior does not occur, the finding is wrong.',
  ];
  return { kind: 'reproducer-sketch', text: lines.join('\n').slice(0, 4000) };
}

// Deterministic grounding checks. The claim is grounded when the judge
// stated a bug claim (verdict report/escalate), every cited code location
// exists on disk with matching content, and at least one location is
// confirmed. artifact_stated only adds a reason when the claim is already
// weak on another ground — it never demotes alone.
function groundedGaps(judgment, evidenceLocs, failedItems, confirmed) {
  const gaps = [];
  const verdict = judgment?.answers?.verdict?.choice;
  if (verdict !== 'report' && verdict !== 'escalate') {
    gaps.push(`judge stated no bug claim (verdict=${verdict || '?'})`);
  }
  if (!evidenceLocs.length) {
    gaps.push('evidence cites no code location (file:line)');
  } else {
    for (const f of failedItems) {
      gaps.push(`evidence cites code not found on disk: ${f.file}:${f.line} (${f.check.reason})`);
    }
    if (!confirmed.length) gaps.push('no cited code location confirmed on disk');
  }
  const aStated = judgment?.answers?.artifact_stated?.probability;
  if (gaps.length && aStated != null && aStated < 0.25) {
    gaps.push(`judge stated no falsifiable artifact (artifact_stated P=${aStated}, ranking signal)`);
  }
  return gaps;
}

writeJsonl(findings);
