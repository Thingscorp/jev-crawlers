// lib/jev.mjs — typed Jev judgments for jev-judge.
//
// Question-config format matches the jev-decide.mjs runner (sets, policy
// routes, predicate DSL), so configs stay portable between the two. The
// gateway key follows the standard CLI config chain: --api-key flag,
// then $AI_GATEWAY_API_KEY, then `api_key=` in ~/.config/jev-crawlers/config
// (KEY=VALUE lines, # comments). It is never read from a repo.
// Context packing has an explicit truncation order (identity first,
// metadata last).
//
// Truncation order (first truncated = first dropped):
//   1. repo metadata (branch, commit, tool versions) — informational only
//   2. evidence list beyond the first 8 entries
//   3. file excerpt window — shrinks symmetrically around the hit line
//      inside the already-windowed excerpt (excerptStartLine is the
//      1-based first line of that window)
// Identity, seed context, and the question block are never truncated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactNode } from './redact.mjs';
import { loadVerdicts, isExpired, verdictDate } from './verdicts.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(configPath) {
  const p = configPath || path.join(SCRIPT_DIR, '..', 'questions', 'crawl-judge.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Parse a KEY=VALUE config file: blank lines and # comments ignored, the
// first '=' splits key from value, surrounding quotes stripped.
export function readKeyValueConfig(p) {
  const out = {};
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

// Standard CLI config chain for the gateway key (first wins):
//   1. --api-key flag (opts.apiKey)
//   2. $AI_GATEWAY_API_KEY
//   3. api_key= in ~/.config/jev-crawlers/config (KEY=VALUE, # comments)
// There is no legacy env var for this key, so the chain has three links.
// The key is never read from a repo.
export function resolveApiKey(opts = {}) {
  if (opts.apiKey && String(opts.apiKey).trim()) return String(opts.apiKey).trim();
  const env = process.env.AI_GATEWAY_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const cfg = readKeyValueConfig(path.join(os.homedir(), '.config', 'jev-crawlers', 'config'));
    if (cfg.api_key && cfg.api_key.trim()) return cfg.api_key.trim();
  } catch { /* no config file; fall through */ }
  return null;
}

// Render one evidence item for the Jev state. Structured items carry
// their kind and file:line so the judge sees what grounds the claim.
// Internal to this module (used by packState); not part of the API.
function fmtEvidence(e) {
  if (typeof e === 'string') return e;
  if (!e || typeof e !== 'object') return String(e);
  const loc = e.file ? `${e.file}${e.line ? ':' + e.line : ''}` : '';
  const tag = e.pattern ? `${e.kind}:${e.pattern}` : (e.kind || 'evidence');
  return `[${tag}]${loc ? ' ' + loc : ''} ${e.text || ''}`.trim();
}

// Build the Jev state for one node. Returns the packed string, a report
// of what was truncated, and the pre-judge redaction record, so callers
// can log them instead of dropping context silently. Exported (not only
// for judgeNode) so the pre-judge redaction guarantee is directly
// testable: pack a node, assert no raw secret in the state.
export function packState(node, opts = {}) {
  // Pre-judge redaction pass (spec: "Secret leakage in evidence" —
  // "evidence extraction applies redaction and deny rules before any
  // remote call"). Credential-shaped values are stripped from the
  // node's text fields HERE, at the single choke point before network
  // access. Local stages (seed, expand, verify) keep working on raw
  // text; only the judge input is redacted.
  const { node: redacted, redactions } = redactNode(node);
  node = redacted;
  const cap = opts.maxStateChars || 6000;
  const lines = [];
  const trunc = [];

  // Never truncated: identity + seed context.
  lines.push(`NODE ${node.id || '(no id)'}`);
  lines.push(`file: ${node.file || '?'}  symbol: ${node.symbol || '?'}  scope: ${node.scope || '<file>'}`);
  lines.push(`kind: ${node.kind || '?'}  depth: ${node.depth ?? 0}`);
  if (node.seed) {
    lines.push(`SEED (${node.seed.type}): ${node.seed.evidence || ''}`.slice(0, 1200));
  }
  if (node.parent) lines.push(`PARENT: ${node.parent}  relation: ${node.relation || '?'}`);

  // File excerpt: already windowed by fileExcerpt. Shrink around the
  // hit using excerptStartLine so an absolute symbolLine of 500 does
  // not slice a 61-line excerpt empty.
  let excerpt = node.excerpt || '';
  let excerptLines = excerpt ? excerpt.split('\n') : [];
  const start = Number(node.excerptStartLine) > 0 ? Number(node.excerptStartLine) : 1;
  const abs = Number(node.symbolLine) > 0 ? Number(node.symbolLine) : start;
  const local = excerptLines.length
    ? Math.min(excerptLines.length - 1, Math.max(0, abs - start))
    : 0;

  // Evidence: structured items render as [kind] file:line text; plain
  // strings (from older nodes) pass through. Keep the first 8, note the rest.
  const evidence = Array.isArray(node.evidence) ? node.evidence : [];
  const keptEvidence = evidence.slice(0, 8);
  if (evidence.length > 8) trunc.push(`dropped ${evidence.length - 8} evidence entries`);
  if (keptEvidence.length) {
    lines.push('EVIDENCE:');
    for (const e of keptEvidence) lines.push(`- ${fmtEvidence(e).slice(0, 500)}`);
  }

  // False-positive feedback loop: append recent human "not-a-bug" verdicts
  // as negative examples so the judge learns the noise classes (fixture
  // files, config/docs prose, log messages, fixture labels). Capped so the
  // state budget stays intact; a missing store is not an error. Expired
  // verdicts are not fed: the ruling lapsed, so the judge reconsiders.
  try {
    const vp = path.join(SCRIPT_DIR, '..', 'data', 'fp-verdicts.json');
    const verdicts = loadVerdicts(vp)
      .filter(v => v && v.verdict === 'false-positive' && !isExpired(v))
      .sort((a, b) => String(verdictDate(b)).localeCompare(String(verdictDate(a))))
      .slice(0, 10);
    if (verdicts.length) {
      const items = verdicts.map(v => {
        const loc = v.file ? `${v.file}${v.line ? ':' + v.line : ''}` : '(class)';
        const ev = v.evidence ? ` matched "${String(v.evidence).slice(0, 120)}"` : '';
        const by = v.author ? ` (ruled by ${v.author})` : '';
        return `- ${loc} [${v.pattern}]${ev}: ruled not-a-bug — ${v.reason}${by}`;
      });
      let block = 'PREVIOUSLY RULED NOT-A-BUG (human verdicts; do not re-report these as bugs):\n' + items.join('\n');
      if (block.length > 2000) block = block.slice(0, 2000) + '\n…[negative examples truncated]';
      lines.push(block);
    }
  } catch { /* no verdict store; proceed without negative examples */ }

  // Excerpt window: default +-40 lines, shrinks symmetrically on overflow.
  // `local` is the hit index inside the already-windowed excerpt.
  let window = opts.excerptWindow || 40;
  let excerptText = '';
  if (excerptLines.length) {
    while (window >= 5) {
      const lo = Math.max(0, local - window);
      const hi = Math.min(excerptLines.length, local + window + 1);
      excerptText = excerptLines.slice(lo, hi).join('\n');
      if (excerptText.length <= 3000) break;
      window = Math.floor(window / 2);
    }
    if (window < 5) trunc.push('excerpt window collapsed below minimum; showing first 30 lines');
    lines.push('EXCERPT:');
    lines.push(excerptText.slice(0, 3000));
  }

  // Metadata last: dropped first under pressure.
  const meta = node.meta || {};
  const metaStr = JSON.stringify(meta).slice(0, 800);
  lines.push(`META: ${metaStr}`);

  let state = lines.join('\n');
  if (state.length > cap) {
    state = state.slice(0, cap) + `\n…[truncated to ${cap} chars]`;
    trunc.push(`hard cap ${cap} chars applied`);
  }
  return { state, truncated: trunc, redactions };
}

// Predicate engine: same DSL as jev-decide (gte/lte/gt/lt/eq/neq/in/between,
// paths like "verdict.choice" or "state.depth").
function getPath(obj, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
// Internal to this module (used by routeOf); not part of the API.
function evalPred(ctx, pred) {
  if (pred && typeof pred === 'object') {
    if (Array.isArray(pred.all)) return pred.all.every((q) => evalPred(ctx, q));
    if (Array.isArray(pred.any)) return pred.any.some((q) => evalPred(ctx, q));
    const entries = Object.entries(pred);
    if (entries.length !== 1) throw new Error('bad predicate: ' + JSON.stringify(pred));
    const [[op, [lhs, rhs]]] = entries;
    const v = getPath(ctx, lhs);
    switch (op) {
      case 'gte': return v >= rhs;
      case 'lte': return v <= rhs;
      case 'gt': return v > rhs;
      case 'lt': return v < rhs;
      case 'eq': return v === rhs;
      case 'neq': return v !== rhs;
      case 'in': return Array.isArray(rhs) && rhs.includes(v);
      case 'between': return Array.isArray(rhs) && v >= rhs[0] && v <= rhs[1];
      default: throw new Error('unknown predicate op: ' + op);
    }
  }
  throw new Error('bad predicate: ' + JSON.stringify(pred));
}
// Internal to this module (used by judgeNode); not part of the API.
function routeOf(set, nested) {
  let route = set.policy.routes[set.policy.routes.length - 1];
  for (const r of set.policy.routes) {
    const when = r.when || [];
    if (when.every((p) => evalPred(nested, p))) { route = r; break; }
  }
  return route;
}

// One Jev judgment for one node. Returns { answers, routing, meaning,
// latencyMs, usage, truncated }. Throws on scorer error.
export async function judgeNode(node, set, opts = {}) {
  const key = resolveApiKey(opts);
  if (!key) {
    throw new Error('AI_GATEWAY_API_KEY is not set. Set it via --api-key, $AI_GATEWAY_API_KEY, or api_key= in ~/.config/jev-crawlers/config (KEY=VALUE lines, # comments).');
  }
  // The 'ai' SDK picks the gateway key up from the environment, so export
  // a flag/config-resolved key for this process (and its children).
  if (process.env.AI_GATEWAY_API_KEY !== key) process.env.AI_GATEWAY_API_KEY = key;
  const { state, truncated, redactions } = packState(node, opts);
  const questions = {};
  for (const [qname, qdef] of Object.entries(set.questions)) {
    const q = { type: qdef.type, instructions: qdef.instructions };
    if (qdef.criteria) q.criteria = qdef.criteria;
    questions[qname] = q;
  }
  if (set.status === 'proposed') {
    process.stderr.write(`jev-judge: WARNING set "${opts.setName || '?'}" is proposed/un-calibrated; result is advisory only.\n`);
  }
  const { experimental_evaluate: evaluate } = await import('ai');
  const t0 = Date.now();
  const result = await evaluate({
    model: opts.model || 'typesafe-ai/jev',
    state,
    questions,
    providerOptions: opts.providerOptions,
  });

  const answers = {};
  const jevConfidence = result.providerMetadata?.typesafe?.confidence || {};
  const marketCostUsd = result.providerMetadata?.gateway?.marketCost != null
    ? Number(result.providerMetadata.gateway.marketCost) : null;
  for (const [qname, qdef] of Object.entries(set.questions)) {
    const a = result.answers?.[qname];
    if (!a) throw new Error(`missing answer for question "${qname}"`);
    const norm = {};
    if (qdef.type === 'boolean') norm.probability = a.probability;
    else if (qdef.type === 'choice') {
      norm.choice = a.choice;
      norm.probabilities = a.probabilities || {};
      const vals = Object.values(norm.probabilities);
      norm.top_probability = vals.length ? Math.max(...vals) : 0;
    } else if (qdef.type === 'score') {
      norm.score = a.score;
      norm.probabilities = a.probabilities || {};
    }
    // Jev's own per-question confidence (R2: vendor-reported, uncalibrated;
    // shown to the reviewer, never treated as calibration).
    if (jevConfidence[qname] != null) norm.confidence = jevConfidence[qname];
    answers[qname] = norm;
  }
  const nested = { state: { depth: node.depth ?? 0, kind: node.kind || '' } };
  for (const [qname, norm] of Object.entries(answers)) nested[qname] = norm;

  const route = routeOf(set, nested);
  return {
    answers,
    routing: route.name,
    meaning: route.meaning || '',
    artifact: answers.report_artifact?.text || null,
    latencyMs: Date.now() - t0,
    usage: result.usage || null,
    // Real list cost when the gateway reports it (measured $0.000035 on
    // 2026-09-19; the driver prefers this over the M2 estimate).
    marketCostUsd,
    // Kept for routing verification (e.g. ZDR planningReasoning, Jev
    // confidence). Surfaced via --show-metadata; never logged by default.
    providerMetadata: result.providerMetadata || null,
    truncated,
    // Pre-judge redaction record (spec's evidence format):
    // [{ class: 'credential', count: N }]. Empty when nothing matched.
    redactions,
  };
}
