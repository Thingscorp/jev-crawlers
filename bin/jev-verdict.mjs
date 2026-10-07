#!/usr/bin/env node
// jev-verdict — append a reviewer outcome record to data/fp-verdicts.json.
//
// Reviewer outcome records close the feedback loop the FP suppression
// started (spec §18): "Suppressions are explicit records with
// fingerprint, reason, author, creation time, and optional expiry."
// Full contract: docs/VERDICTS.md.
//
// Example:
//   bin/jev-verdict.mjs \
//     --fingerprint sha256:<64 hex> \
//     --verdict false-positive \
//     --reason "Fixture label, not a committed secret." \
//     --author russ \
//     --file examples/labeled-eval/bugs.js --line 21 \
//     --pattern pattern:auth --evidence "return eval(userExpr);"
//
// Required: --fingerprint, --verdict, --reason, --author.
// Optional: --expires YYYY-MM-DD, --file, --line, --pattern, --evidence.
// Malformed records are refused (exit 2); nothing is appended.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../lib/io.mjs';
import { VERDICT_VALUES, FINGERPRINT_RE, loadVerdicts } from '../lib/verdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, '..', 'data', 'fp-verdicts.json');

function printVersion() {
  let v = 'unknown';
  try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  console.log(`jev-verdict ${v}`);
  process.exit(0);
}

function printHelp() {
  console.log(`usage: jev-verdict --fingerprint sha256:<hex> --verdict ${VERDICT_VALUES.join('|')}
                   --reason "..." --author "..."
                   [--expires YYYY-MM-DD] [--file PATH] [--line N]
                   [--pattern pattern:name] [--evidence "..."]
                   [--no-color] [--version]

Append one reviewer outcome record to data/fp-verdicts.json, closing the
feedback loop the FP suppression started. Malformed records are refused
(exit 2); nothing is appended.

Options:
  --fingerprint F   required; sha256:<64 lowercase hex> — the finding's
                    stable cross-run identity
  --verdict V       required; ${VERDICT_VALUES.join(' | ')}
  --reason TEXT     required; why the reviewer ruled this way
  --author NAME     required
  --expires DATE    optional; record stops applying after this date
  --file PATH       optional; repo-root-relative file for the matcher
  --line N          optional; positive integer
  --pattern NAME    optional; e.g. pattern:auth
  --evidence TEXT   optional; the exact evidence text that repeats
  --no-color        no color output (output is plain text anyway)
  -h, --help        this help
  --version         print version

Output: the appended record as JSON on stdout — already machine-readable.

Exit codes: 0 success, 1 runtime error, 2 usage/config error.

Examples:
  jev-verdict --fingerprint sha256:9f2c0000000000000000000000000000000000000000000000000000000000 \\
    --verdict false-positive --reason "Fixture label, not a committed secret." \\
    --author russ --file examples/labeled-eval/bugs.js --line 21 \\
    --pattern pattern:auth --evidence "return eval(userExpr);"`);
  process.exit(0);
}

const args = process.argv.slice(2);
let fingerprint = null, verdict = null, reason = null, author = null,
  expires = null, file = null, line = null, pattern = null, evidence = null,
  noColor = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--fingerprint' && args[i + 1]) fingerprint = args[++i];
  else if (a === '--verdict' && args[i + 1]) verdict = args[++i];
  else if (a === '--reason' && args[i + 1]) reason = args[++i];
  else if (a === '--author' && args[i + 1]) author = args[++i];
  else if (a === '--expires' && args[i + 1]) expires = args[++i];
  else if (a === '--file' && args[i + 1]) file = args[++i];
  else if (a === '--line' && args[i + 1]) line = args[++i];
  else if (a === '--pattern' && args[i + 1]) pattern = args[++i];
  else if (a === '--evidence' && args[i + 1]) evidence = args[++i];
  else if (a === '--no-color') noColor = true;
  else if (a === '--version') printVersion();
  else if (a === '--help' || a === '-h') printHelp();
  else fail(`unknown arg ${a}`, 2);
}

// Refuse malformed records: nothing is written unless every check passes.
if (!fingerprint || !FINGERPRINT_RE.test(fingerprint))
  fail('--fingerprint is required and must look like sha256:<64 lowercase hex>', 2);
if (!VERDICT_VALUES.includes(verdict))
  fail(`--verdict is required and must be one of: ${VERDICT_VALUES.join(', ')}`, 2);
if (!reason || !reason.trim()) fail('--reason is required and must not be empty', 2);
if (!author || !author.trim()) fail('--author is required and must not be empty', 2);
let expiresIso = null;
if (expires != null) {
  const t = Date.parse(expires);
  if (!Number.isFinite(t)) fail(`--expires is not a parseable date: ${expires}`, 2);
  expiresIso = new Date(t).toISOString();
}
let lineNum = null;
if (line != null) {
  lineNum = Number(line);
  if (!Number.isInteger(lineNum) || lineNum < 1) fail(`--line must be a positive integer: ${line}`, 2);
}

const record = {
  fingerprint,
  file: file ?? null,
  line: lineNum,
  pattern: pattern ?? null,
  evidence: evidence ?? null,
  verdict,
  reason: reason.trim(),
  author: author.trim(),
  created: new Date().toISOString(),
  expires: expiresIso,
};

const records = loadVerdicts(STORE);
records.push(record);
fs.writeFileSync(STORE, JSON.stringify(records, null, 2) + '\n');
console.log(JSON.stringify(record));
