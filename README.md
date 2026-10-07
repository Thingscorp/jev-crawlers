# jev-crawlers

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![test](https://github.com/Thingscorp/jev-crawlers/actions/workflows/test.yml/badge.svg)](https://github.com/Thingscorp/jev-crawlers/actions/workflows/test.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](package.json)

**Jev learns your repo's decision norms, then adversarially judges past decisions against them** — as small unix tools for bug-discovery: one tool, one job, JSON lines on stdin/stdout, composed with pipes.

AI writes code faster than humans can review it. Linters match patterns; one-shot AI reviewers read a diff once and stop. These tools follow the lead — "who else calls this?", "what config changes it?", "where does this input become trusted?" — until the lead dries up. The trick is cheap judgment: [Jev](https://vercel.com/docs/ai-gateway) (typesafe-ai/jev, via the Vercel AI Gateway) returns typed verdicts (choice, boolean, score) for a fraction of a cent per node in our calibration runs, so you can judge every node instead of every scan.

## Verified claims

Every claim below is backed by a mocked test in `test/` — no network, no key, no charges. Run them yourself: `npm test` (`node --test 'test/*.test.mjs'`: 46 tests across 9 files).

| Claim | Backing data |
|---|---|
| Credentials are redacted before the judge state is built | `test/pack-state.test.mjs`: `packState` strips the value from `api_key = "..."` and the state contains `[REDACTED:credential]`; `test/redact.test.mjs`: key-name assignment redacts only the value, PEM private keys redacted (certificates not), `ghp_`/`sk-ant-`/`sk-` prefixes redacted, short fragments and prose mentions untouched |
| Excerpts are windowed around the hit line, never the first N lines of the file | `test/search.test.mjs`: `fileExcerpt` windows ±N around line 50 of 80 and reports `excerptStartLine`; `test/pack-state.test.mjs`: a deep hit at line 500 with `excerptStartLine` keeps `HIT-500` and drops `HIT-1` |
| Fabricated or missing citations demote to unverified lead — never bug | `test/verify.test.mjs`: 8 tests piping records through `bin/jev-verify.mjs` — mismatching line content, missing files, and the phantom trailing-newline line with fabricated text all demote with an explanatory note; matching lines ground |
| node_modules, secret files, and dist/build/vendor/.git are skipped, at root and nested | `test/search.test.mjs`: `loadIgnores` ignores `sub/dist/a.js` and `sub/node_modules/x.js` while keeping lookalikes (`distant/`, `mybuild/`, `buildinfo.txt`) |
| Expansion finds files committed together; degrades to `[]` on git failure | `test/search.test.mjs`: a tmp git repo — `coChangedFiles` counts 2 co-changes for `b.js` and never lists the queried file itself; returns `[]` when nothing co-changes or git fails |
| Finding fingerprints are stable across runs and outcomes | `test/fingerprint.test.mjs`: the same claim yields the same `sha256:<64 hex>` regardless of status or evidence order; a different location yields a different fingerprint |
| The frontier pops highest priority first, then shallowest depth | `test/graph.test.mjs`: pop order is `high-shallow`, `high-deep`, `low` |
| Verdict records validate shape; expiry is honored | `test/verdicts.test.mjs`: `isExpired` is false without an expiry and true when past, `verdictDate` prefers `created`, `loadVerdicts` returns `[]` for a missing store, `FINGERPRINT_RE` matches `sha256:<64 hex>` |

## Quickstart

```sh
npm install
./bin/crawl --repo ./examples/todo-app --dry-run --budget 8
```

`--dry-run` stubs judgments, so the first run needs no key and costs nothing.

## Install

Node 20 or newer. `npm install` pulls the one dependency (`ai`, used by `jev-judge` for the Jev call). Run `npm test` to verify your checkout.

## Usage

Run a crawl:

```sh
export AI_GATEWAY_API_KEY="your-key-here"   # or api_key= in ~/.config/jev-crawlers/config
./bin/crawl --repo /path/to/your/repo --seed diff --budget 40 --out report.md
```

Or run the pipe by hand, stage by stage:

```sh
./bin/jev-seed.mjs --repo /path/to/repo --todo \
  | ./bin/jev-expand.mjs --repo /path/to/repo \
  | ./bin/jev-judge.mjs \
  | ./bin/jev-verify.mjs --repo /path/to/repo \
  | ./bin/jev-report.mjs --out report.md
```

The five stage tools and the driver:

- **jev-seed**: emits starting leads, one per line. Sources: the current diff, TODO and FIXME comments, and risky patterns (auth, money movement, eval, shell). Human false-positive verdicts (`data/fp-verdicts.json`) suppress exact repeats; suppressions log to stderr.
- **jev-expand**: follows context cues from one lead. It finds symbol references (callers), files that change together in git history, and config files that name the symbol. Mechanical. No model calls.
- **jev-judge**: one Jev call per node. Typed answers: a `verdict` suggestion (expand, report, prune, escalate), a `bug_likely` ranking signal, a `risk` score from 0 to 3, and whether a falsifiable artifact is stated. Routing follows the risk bands; no route is gated on a raw boolean. Recent human false-positive verdicts ride along as negative examples.
- **jev-verify**: a separate verifier and the keeper of the set (see below). It builds a falsifiable artifact for each report candidate (reproducer sketch) and checks that the artifact is grounded in real code: every cited file:line must exist on disk with matching content. Fabricated or missing citations fail closed. Anything that fails is an **unverified lead**, never a bug.
- **jev-report**: renders the findings with full evidence chains.
- **jev-verdict**: records a human reviewer outcome (false-positive or accepted-finding) in `data/fp-verdicts.json`, closing the feedback loop.
- **crawl**: a thin orchestrator over the pipe. It owns recursion: canonical node identity (file, symbol, scope), a visited set, a priority frontier, and four stop rules (budget spent, depth cap, empty frontier, diminishing returns). The stages stay dumb filters; all orchestration lives here. The limits live outside the tools as flags and policy: `--budget` caps Jev spend, `--depth` caps recursion, the diminishing-returns gate stops dead crawls, and the question set routes low-confidence or high-blast-radius findings to a human.

Copy `.crawlersignore` into the target repo to skip generated and vendored code. It never reads `.env` files.

### jev-verify as a standalone gate

`jev-verify` is deliberately dependency-light: node 20+, one shared helper file (`lib/io.mjs`), no Jev calls, no key, no crawler imports. It takes `{ node, judgment }` records on stdin — from any pipeline that can emit them — and writes findings on stdout, one JSON object per line:

```sh
some-other-pipeline --format ndjson \
  | ./bin/jev-verify --repo /path/to/code --risk-floor 1
```

Each input record needs the shape the verifier grounds against: the node's `file`, `symbol`, `excerpt`, and structured `evidence` items with `file:line` citations (`{ kind: 'code', file, line, text }`), plus the judgment's `routing` and `answers` (`verdict.choice`, `risk.score`, `artifact_stated.probability`, `bug_likely.probability`). The verifier reads every cited file:line off disk and confirms it exists with matching content; a fabricated citation demotes the finding to an **unverified lead** by itself. Routings in the escalate family (`escalate-owner`, `needs-artifact`, `review-queue`) pass through as `escalated` — the verifier never invents a bug claim the judge did not make. Driver-internal routings (`expand-node`, `auto-prune`) are not findings and produce no output; the driver consumes those before verification.

Example: gating the ThatMgmt Jev loop. The loop's gates (`ralph-jev`) already emit typed judgments per step; piping a gate's output through `jev-verify` before acting on a `file-report`-style claim adds the evidence-grounding check for free:

```sh
node libexec/jev-decide.mjs --gate output-verify --format ndjson \
  | /path/to/jev-crawlers/bin/jev-verify --repo /path/to/thatmgmt --risk-floor 1 \
  | node -e "let s='';for await (const c of process.stdin) s+=c;
     for (const l of s.split('\n')) { if (!l.trim()) continue;
       const f = JSON.parse(l);
       if (f.status === 'bug') { console.log('GROUNDED:', f.artifact.text.split('\n')[0]); process.exit(0); }
       if (f.status === 'unverified-lead') { console.log('DEMOTED:', f.note); process.exit(1); } }"
```

Exit 0 means the claim cites real code; exit 1 means it did not survive verification. The gate keeps its own policy; `jev-verify` only answers "does this claim cite real code?"

### Record a false positive

```sh
./bin/jev-verdict.mjs \
  --fingerprint sha256:<64 hex from the finding> \
  --verdict false-positive \
  --reason "Fixture label, not a committed secret." \
  --author russ \
  --file examples/labeled-eval/bugs.js --line 21 \
  --pattern pattern:auth --evidence "return eval(userExpr);"
```

Suppression needs an exact repeat of file, pattern, and evidence text; it never weakens patterns. See `docs/VERDICTS.md` for the full contract.

## Configuration

| Variable | Needed by | Purpose |
|---|---|---|
| `AI_GATEWAY_API_KEY` | `jev-judge` (and `crawl`) | Vercel AI Gateway key. Never prompted for, never logged, never stored in the repo. |

The key follows the standard CLI config chain — first source found wins:

1. `--api-key` flag (prefer the options below — flags can leak into shell history and process listings)
2. `$AI_GATEWAY_API_KEY` environment variable
3. `api_key=` in `~/.config/jev-crawlers/config`

```ini
# ~/.config/jev-crawlers/config — KEY=VALUE lines, # comments
api_key=...
```

There is no legacy env var for this key. A missing key stops the judge with setup instructions — it never prompts and never logs. Target-repo config: copy `.crawlersignore` into the repo under audit to skip generated and vendored code. Deny-listed secret files (`.env`, private keys, `*.pem`) are never read; credential-shaped values are redacted before any network call (full contract: `docs/REDACTION.md`).

## CLI reference

Every tool exits `0` on success, `1` on runtime error, `2` on usage/config error. Every tool accepts `-h`/`--help` (Usage / Options / Examples), `--version`, and `--no-color`; output is plain text everywhere, so piped output is always color-free. The stage tools speak NDJSON on stdin/stdout, already machine-readable.

### crawl

| Flag | Default | Purpose |
|---|---|---|
| `--repo PATH` | cwd | repo to crawl |
| `--seed KIND` | diff, todo, patterns | repeatable; seed source |
| `--base REF` | HEAD | diff base for `--seed diff` |
| `--budget N` | 60 | max Jev judgments |
| `--depth N` | 6 | max expansion depth |
| `--decay F` | 0.85 | child priority decay per depth |
| `--max-children N` | 12 | expansion cap per node |
| `--only F,...` | — | restrict seeds to these files |
| `--api-key KEY` | — | gateway key (see Configuration) |
| `--out FILE` | stdout | write the Markdown report to FILE |
| `--json [FILE]` | — | findings JSON; to FILE, or stdout when bare |
| `--stats-json` | off | run stats as JSON on stderr |
| `--telemetry` | off | append one NDJSON run record to `data/telemetry.jsonl` (see `docs/TELEMETRY.md`) |
| `--dry-run` | off | stub judgments; no Jev calls, no key |

### jev-seed

| Flag | Default | Purpose |
|---|---|---|
| `--repo PATH` | cwd | repo to seed from |
| `--diff` / `--todo` / `--patterns` | all three | seed sources |
| `--base REF` | HEAD | diff base for `--diff` |
| `--only F,...` | — | restrict to these files |

### jev-expand

| Flag | Default | Purpose |
|---|---|---|
| `--repo PATH` | cwd | repo under audit |
| `--kinds LIST` | symbol-refs,co-change,config-ref | subset of expansion kinds |
| `--max-children N` | 12 | cap per input batch |

Reads one node (or a JSON array) on stdin; writes one child node per line. Mechanical — no model calls, no key.

### jev-judge

| Flag | Default | Purpose |
|---|---|---|
| `--config PATH` | questions/crawl-judge.json | question set file |
| `--set NAME` | crawl-judge | which set in the config |
| `--max-state-chars N` | 6000 | cap the Jev state string |
| `--api-key KEY` | — | gateway key (see Configuration) |
| `--dry-run` | off | deterministic stub judgment; no key |
| `--show-metadata` | off | include `providerMetadata` (planningReasoning, Jev confidence) to verify ZDR routing on your plan |

### jev-verify

| Flag | Default | Purpose |
|---|---|---|
| `--risk-floor F` | 1 | minimum risk score to verify |
| `--repo PATH` | cwd | repo to ground citations against |

Output statuses: `bug` | `unverified-lead` | `escalated`. No Jev calls, no key.

### jev-report

| Flag | Default | Purpose |
|---|---|---|
| `--out FILE` | stdout | Markdown report destination |
| `--json [FILE]` | — | findings JSON; FILE, or stdout when bare |
| `--stats JSON` | — | crawl stats object, rendered as a stats section |

### jev-verdict

| Flag | Purpose |
|---|---|
| `--fingerprint F` | required; `sha256:<64 hex>` — the finding's stable cross-run identity |
| `--verdict V` | required; `false-positive` \| `accepted-finding` |
| `--reason TEXT` | required |
| `--author NAME` | required |
| `--expires DATE` | optional; record stops applying after this date |
| `--file PATH` | optional; repo-root-relative file for the matcher |
| `--line N` | optional; positive integer |
| `--pattern NAME` | optional; e.g. `pattern:auth` |
| `--evidence TEXT` | optional; the exact evidence text that repeats |

## Honest limits

This is an experiment, not a finished product. Read this before you trust it. Every assumption below is classified and sourced in `docs/ASSUMPTIONS.md` (measured, research-backed, or unvalidated).

- **Routing follows the risk score, never a raw boolean.** Our 37-case calibration showed the risk score separates safe from unsafe (safe mean 1.16, unsafe mean 2.19, zero false-safe), while the raw booleans are unusable as gates (`safe_to_automerge` recall 0.00 at threshold 0.5). Policy routes are driven by the `risk` score bands; the `verdict` choice and the booleans are supporting signals only.
- **Jev probabilities are ranking signals, not calibrated bug confidence.** A P0.8 from the judge means "rank this above the P0.4 lead", not "this is a bug with 80% probability". The vendor says the same: choose thresholds from labeled examples in your own workflow.
- **The review queue is the primary sink.** Jev is conservative and escalation-happy (`needs_human` mean 0.66 in calibration), so the design treats that as the product's shape: uncertain leads go to a human, escalation is a first-class outcome, and auto-prune is the hardest route to take (it needs converging evidence: the judge chose prune, the risk band is low, and the boolean shows support for false).
- **Only one small labeled eval of Jev bug detection exists so far.** `docs/EVAL.md` §8 ran the judge on 12 labeled code nodes (6 seeded bugs, 6 benign): perfect risk-band separation and routing. n=12, one fixture, bugs chosen to be visible. A start, not proof. Whether the separation holds on real code is still unvalidated. See `docs/ASSUMPTIONS.md`.
- **Zero data retention is requested and verified on our plan.** The judge config asks the gateway for zero data retention, and a live call on our plan returned planningReasoning: "ZDR requested: all 1 attempts support ZDR" with a 200. One observation, not a guarantee: per-request ZDR is a Pro/Enterprise feature per Vercel's docs, and routing can differ by plan and model. Verify on yours: `./bin/jev-judge.mjs --show-metadata < node.json` and read `providerMetadata.gateway.routing.planningReasoning` before you send private code.
- **Jev cannot see images.** States carry text evidence only.
- **Cost and latency are measured.** Live judgments cost about $0.00006 per call (gateway-reported list cost, mean over 493 nodes on a real repo, 2026-09-19), inside the $0.00008 per-call headroom budget. A 500-node crawl measured $0.03 total, 1,432 mean input tokens per node, 10.2 minutes wall clock at 6-parallel judging, mean latency 2.5 s per call. The driver uses the gateway-reported cost when it is present and reports the cost for every crawl. Heavy multi-file context can cost more; that upper band is still derived, not measured. Budget accordingly.
- **Pre-judge redaction.** Credential-shaped values (key-named assignments, `Authorization: Bearer` tokens, high-entropy blobs) are stripped from excerpts and evidence and replaced with `[REDACTED:credential]` before any network call; local stages (seed, expand, verify) still work on raw text. Deny-listed secret files (`.env`, private keys, `*.pem`) are never read. Full contract: `docs/REDACTION.md`.
- **Verification v0 checks grounding, not execution.** The verifier confirms the artifact names real code on disk. It does not run the reproducer. Measured 2026-09-19 (M20, supersedes M18): on 6 human-confirmed bugs with the full production chain (driver attaches the node's own cited code locations before verification), the verifier accepted 6/6 bugs and 0/6 benign cases (precision 1.00, recall 1.00). With the judge's natural routing, 2/6 bugs are accepted as bugs and 4/6 escalate to a human. Re-measured 2026-09-20 after the unix-pipe rebuild (`jev-seed | jev-judge | jev-verify`): forced path still 6/6 and 0/6, evidence-stripped still 0/12; natural routing 3/6 accepted and 3/6 escalated (judge variance of one node between runs). See `docs/EVAL.md` §20. Scope: n=12 on a synthetic fixture; the check is falsifiability-grounding, not independent bug derivation. Findings say "artifact attached, reproducer not executed".
- **The question set is proposed and uncalibrated.** All thresholds (risk bands at 1 and 2, the prune rule, the diminishing-returns gate) are reasoned, not measured. Tune them only after measuring precision and recall on your own seeded bugs.

## The question set

`questions/crawl-judge.json` holds the Jev question set for node verdicts. Routing is driven by the `risk` score bands (low: below 1, moderate: 1 to 2, high: 2 and up), the measured strength from our calibration; no route is decided by a raw boolean alone. The review queue is the default sink and auto-prune needs converging evidence (explicit prune choice, low risk band, and the boolean showing support for false). The set is **proposed and uncalibrated**: every threshold is reasoned, not measured. One file, human-reviewable, same format as the jev-decide runner. See `docs/ASSUMPTIONS.md` for what is measured, what is research-backed, and what is still unvalidated. Tune the thresholds only after you measure precision and recall on your own seeded bugs.

## Docs

- `docs/crawlers-spec.pdf`: the full 37-page product specification.
- `docs/ARCHITECTURE.md`: graph model, data contracts, termination, and cost math.
- `docs/EVAL.md`: what was measured and when. The latest section is the current truth; older sections are history.
- `docs/ASSUMPTIONS.md`: every design claim classified as measured, research-backed, or unvalidated. Read before changing a threshold.
- `docs/REDACTION.md`: the pre-network redaction contract.
- `docs/VERDICTS.md`: the false-positive verdict store schema.
- `docs/TELEMETRY.md`: the opt-in telemetry record format.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: one tool, one job; stages speak JSON lines; orchestration lives in `bin/crawl`. Do not invent thresholds — measure first, write the result into `docs/EVAL.md`, and classify the claim in `docs/ASSUMPTIONS.md`. Redact before the network (`lib/redact.mjs`, tests in `test/redact.test.mjs`); excerpts stay windowed around the hit line.

## License

MIT. See [LICENSE](LICENSE).
