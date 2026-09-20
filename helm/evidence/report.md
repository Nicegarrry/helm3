# One-shot report

Date: 2026-09-18 (updated after the continuation). Branch: `claude/helm3-assessment-simplify-qsdefo`. Package: `helm/`.

## 1. Exit proofs

| Wave | Exit proof | Result |
| --- | --- | --- |
| A | Orchestrator calls spawn, inspect, gate.run, pr.open against a real repo with a real model; a real PR exists with a green gate at its head | **Met live, 2026-09-20.** `opencode-go/qwen3.8-flash` wrote the missing `targets.test.ts` in `Nicegarrry/brief`, the gate passed at head `96d59be` (2,709 tests), and `pr.open` produced the real draft PR [Nicegarrry/brief#248](https://github.com/Nicegarrry/brief/pull/248), confirmed independently with `gh`. `src/github.ts` needed no fix against real `gh`. A free-model smoke on a synthetic scratch repo ran first. See [live.md](live.md) "Wave A". |
| B | Kill the daemon mid-run, restart, worker shows interrupted, steer resumes it, spend reported, reviewer comment on the PR | **Met live, after a fix.** `google/gemini-3.8-flash` posted an APPROVE comment on #248, and the cross-family and same-model guards both refused without `allowSameFamily`. SIGINT mid-run → `interrupted` on restart → `steer` resumed **the same** Pi session to a passing gate. The first attempt did not: a killed turn left `sessionFile: null` and the resume started a fresh session with no context. Fixed and re-proven. Soft cap warns and returns a `warning` on spawn; hard cap refuses. See [live.md](live.md) "Fix 2" and "Wave B". |
| C | Three workers in parallel visible from one terminal | **Met live.** Three builders on brief at `HELM_MAX_WORKERS=3`, each adding a missing test file for a different untested module, for $0.021 all in. Dashboard screenshot with all three running: [live-dashboard.png](live-dashboard.png). See [live.md](live.md) "Wave C". |
| — | An orchestrator drives Helm over MCP (README's central claim) | **Met in v1.1.** `worker.wait` replaces polling; the same job re-run under v1.1 is measured in [live.md](live.md) "v1.1". The v1 result stands as the before: **Partly met.** A fresh Claude Code session restricted to `mcp__helm` tools — no file, edit or shell tools — spawned, gated, opened [brief#249](https://github.com/Nicegarrry/brief/pull/249) and requested a review, touching nothing itself. But 299 of its 309 turns were `worker_inspect` polls, costing $16.82 of its own context against $0.052 for the worker. There is no wait or long-poll tool. See [live.md](live.md) "Section 5". |

Evidence files: `helm/evidence/log.md`, `helm/test/e2e.test.ts`, test output below.

```
npx tsc --noEmit          clean
npm test                  99 tests, 99 pass, 0 fail   (52 at the first commit, 95 before the live run)
```

Continuation on 2026-09-18 (owner cleared up to 12 hours): an adversarial review found 14
confirmed defects, all fixed with regression tests; `owner/name` cloning, persisted context
paths, an HTML status page, and a simplification pass were added. Details in `log.md` and
`worklist.md`.

## 2. Spend

Zero for the faux-provider build. The live run on 2026-09-20 cost **$0.367** in Helm-tracked
worker spend against a $5 cap, across 14 workers and three models.

Separately, the section-5 orchestrator burned the equivalent of **$16.82** of its own context,
almost all of it polling. On a subscription that draws on plan usage rather than a bill, so it
is not a spend problem — but it is a design one, and it is recorded as a finding in `live.md`.

## 3. Line counts

| | Lines |
| --- | --- |
| `helm/src/*.ts` (13 files) | 2,817 |
| `helm/test/*.ts` (11 files) | 2,445 |

Old `src/` for comparison: 10,664 lines, 16 SQLite tables. New: 5 tables.

## 4. Gaps

- ~~**No way to wait.**~~ Closed in v1.1 by `worker.wait`. The v1 measurement (299 polls across
  309 turns for one worker) and the v1.1 re-run are side by side in `live.md`.
- ~~**Live proof.**~~ Done 2026-09-20 on the owner's machine; see `live.md`.
- ~~**`gh` transport untested against real `gh`.**~~ Exercised live: `pr.open`, `pr.status` and
  the reviewer's PR comment all worked against real `gh` with no change to `src/github.ts`.
  `pr.merge` first ran live in v1.1 and refused a green PR: `gh` reports conclusions upper-case
  and the guard compared lower-case. Fixed at the boundary; brief#248 was then merged through
  Helm. `merge_method` is hard-wired to `squash` — worth making configurable.
- **`helm status` misreports the cap.** The CLI reads the store with its own environment, so
  `run.status` from a shell shows `spendCapUsd: 0` while the daemon holds the real cap.
  Enforcement is correct; only the CLI's reporting is wrong. Either read the cap from
  `serve.json` or ask the daemon.
- **Gate config is read from the source repo, not the worktree.** `defaultChecks(row.repo)`
  means `helm.json` is taken from the repo the operator pointed at, at gate time — so a branch
  cannot change its own gates, and an uncommitted `helm.json` silently governs. Convenient for
  setup, surprising on reflection; worth a line in the README either way.
- **Stop is cooperative.** `worker.stop` aborts at the next tool call boundary; a model
  mid-generation finishes that generation first. If the turn never reaches a tool call the
  stop stays pending and the worker reports `unknown` until it settles.
- **Bash is not sandboxed.** The deny list blocks pushes, `gh`, worktree surgery and
  checkouts, and paths are contained for the file tools, but a worker's shell can still read
  outside the worktree. OS-level isolation is the operator's job.
- **`helm.ts` is 511 lines** against a 450 target after the simplification pass; the rest is
  contract boilerplate and the protected run loop. `src/` totals 2,817 lines against the 3k
  ceiling, so the next addition has to be paid for by a cut.
- ~~**One session at a time.**~~ In v1.1 the stdio MCP server and the daemon were one process, so a
  second project's session could not start and the first's server outlived its client. v1.2
  splits them: one daemon per `HELM_HOME`, any number of per-session front-ends. Proven live with
  two repos at once; see `live.md` "v1.2".
- **The daemon's environment is the first session's.** `HELM_SPEND_CAP_USD` and friends come
  from whichever `.mcp.json` started the daemon; a later project's `env` is ignored while it runs.
  Per-project isolation is a per-project `HELM_HOME`.
- **The dashboard serves no favicon**, so every page load logs a 404. Cosmetic.

## 5. Recommendations

1. ~~Run the live Wave A proof.~~ Done; see `live.md`.
2. ~~**Add a `worker.wait` tool.**~~ Done in v1.1.
3. Retire `src/`, `test/` and the wave docs behind the `legacy-control-plane` tag and make
   `helm/` the repo root.
4. Close issues #8, #10, #11, #27 as done and park the rest under one "deferred design" issue,
   as the assessment proposed.

## 6. Proposed replacement for the root AGENTS.md (not applied)

```
# Helm agent contract

Helm is a harness: an orchestrator agent calls Helm tools; Helm runs Pi workers on cheap
models in isolated worktrees, runs gates, opens PRs and reports status durably. The code
lives in `helm/`. Read `helm/README.md` first.

## Rules
- GitHub owns issues and PRs. Helm owns worker state in `$HELM_HOME/helm.sqlite`.
- One worker per worktree. Workers never push; `pr.open` pushes after a passing gate.
- A PR merges only when checks are green at the exact head the gate passed on.
- Spend is capped by `HELM_SPEND_CAP_USD`. Unknown prices are reported, never blocked.
- Credentials stay in Pi's own store and `gh`. Never in the repo, config or logs.
- No purchases, top-ups or account changes. Free routes see synthetic content only.
- Workers report a JSON `WorkerResult`; a model's claim is not evidence until a gate ran.

## Working method
- Product changes are PRs from worktrees. Keep `helm/` under 3k lines; cut before adding.
- Prefer open models via OpenCode or OpenRouter for builders; a different family for review.
- Run `npm test` in `helm/` before pushing. The old `src/` is legacy and not extended.
```
