#!/usr/bin/env node
// jev-judge — one Jev judgment per node.
// Reads nodes (NDJSON or a JSON array) from stdin, writes one
// { node, judgment } object per line (NDJSON). The judgment carries the
// (verdict choice, bug_likely boolean, risk score, artifact_stated
// boolean), the policy routing, and latency/usage. Routing is driven by
// the risk score bands; no route is gated on a raw boolean.
//
// Exit codes: 0 = judged (routing in JSON), 1 = runtime/scorer error,
// 2 = usage/config error. The repo never holds a key; the gateway key
// follows the standard config chain (--api-key, $AI_GATEWAY_API_KEY,
// api_key= in ~/.config/jev-crawlers/config).
// --dry-run returns a deterministic stub judgment without calling Jev
// (for pipeline tests; never for real verdicts).
// --show-metadata includes providerMetadata (planningReasoning, Jev
// confidence) so operators can verify ZDR routing on their own plan.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, asArray, writeJsonl, fail } from '../lib/io.mjs';
import { loadConfig, judgeNode } from '../lib/jev.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function printVersion() {
  let v = 'unknown';
  try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  console.log(`jev-judge ${v}`);
  process.exit(0);
}

function printHelp() {
  console.log(`usage: jev-judge [--config PATH] [--set NAME] [--max-state-chars N]
                 [--api-key KEY] [--dry-run] [--show-metadata]
                 [--no-color] [--version] < node.json

One Jev judgment per node. Reads nodes (NDJSON or a JSON array) from
stdin; writes one { node, judgment } object per line (NDJSON) — already
machine-readable. The judgment carries verdict choice, bug_likely
probability, risk score, artifact_stated probability, and the policy
routing. Routing is driven by the risk score bands; no route is gated
on a raw boolean.

Options:
  --config PATH       question set (default: questions/crawl-judge.json)
  --set NAME          which set in the config (default: crawl-judge)
  --max-state-chars N cap the Jev state string (default: 6000)
  --api-key KEY       Vercel AI Gateway key (see Configuration below)
  --dry-run           deterministic stub judgment; no Jev call, no key
  --show-metadata     include providerMetadata (planningReasoning, Jev
                      confidence) to verify ZDR routing on your plan
  --no-color          no color output (output is plain text anyway)
  -h, --help          this help
  --version           print version

Configuration — the gateway key, first source found wins:
  --api-key flag (prefer the options below — flags can leak into shell
  history and process listings); $AI_GATEWAY_API_KEY;
  api_key= in ~/.config/jev-crawlers/config (KEY=VALUE lines, # comments).
  The key is never prompted for and never logged.

Exit codes: 0 judged (routing in JSON), 1 runtime/scorer error,
2 usage/config error.

Examples:
  jev-seed --repo /path/to/repo --diff | jev-judge
  jev-seed --repo /path/to/repo --diff | jev-judge --dry-run
  jev-judge --show-metadata < node.json   # verify ZDR before private code`);
  process.exit(0);
}

const args = process.argv.slice(2);
let configPath = null, setName = 'crawl-judge', dryRun = false, maxStateChars = null,
  showMetadata = false, noColor = false, apiKey = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--config' && args[i + 1]) configPath = args[++i];
  else if (a === '--set' && args[i + 1]) setName = args[++i];
  else if (a === '--max-state-chars' && args[i + 1]) maxStateChars = parseInt(args[++i], 10);
  else if (a === '--api-key' && args[i + 1]) apiKey = args[++i];
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--show-metadata') showMetadata = true;
  else if (a === '--no-color') noColor = true;
  else if (a === '--version') printVersion();
  else if (a === '--help' || a === '-h') printHelp();
  else fail(`unknown arg ${a}`, 2);
}

const input = await readStdinJson();
if (!input) process.exit(0); // empty pipe in: empty pipe out

if (dryRun) {
  const out = asArray(input).map((node) => ({
    node,
    judgment: {
      dryRun: true,
      answers: {
        verdict: { choice: 'expand', probabilities: { expand: 1 }, top_probability: 1 },
        bug_likely: { probability: 0.5 },
        risk: { score: 1 },
        artifact_stated: { probability: 0 },
      },
      routing: 'expand-node',
      meaning: 'dry-run stub: always expand',
      latencyMs: 0,
    },
  }));
  writeJsonl(out);
  process.exit(0);
}

let config;
try { config = loadConfig(configPath); }
catch (e) { fail(`cannot read config: ${e.message}`, 2); }
const set = config.sets?.[setName];
if (!set) fail(`unknown set "${setName}"`, 2);

const out = [];
for (const node of asArray(input)) {
  try {
    const judgment = await judgeNode(node, set, {
      setName, maxStateChars, model: config.model, providerOptions: config.providerOptions, apiKey,
    });
    if (!showMetadata) delete judgment.providerMetadata;
    out.push({ node, judgment });
  } catch (e) {
    writeJsonl({ set: setName, status: set.status || 'active', routing: 'review', error: String(e.message || e).slice(0, 300) });
    process.stderr.write(`jev-judge ERROR: ${String(e.message || e).slice(0, 200)} -> treat as review\n`);
    process.exit(1);
  }
}
writeJsonl(out);
process.exit(0);
