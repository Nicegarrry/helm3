# One-shot report

Date: 2026-09-18 (updated after the continuation). Branch: `claude/helm3-assessment-simplify-qsdefo`. Package: `helm/`.

## 1. Exit proofs

| Wave | Exit proof | Result |
| --- | --- | --- |
| A | Orchestrator calls spawn, inspect, gate.run, pr.open against a real repo with a real model; a real PR exists with a green gate at its head | **Partially met.** The full chain runs end to end in `test/e2e.test.ts` on the real composition (SQLite store, git worktree, gate runner, Pi session, HTTP daemon) with Pi's faux provider and a fake `gh`. A faux worker wrote a file, its `git push` was refused by the hook, Helm committed, the gate passed at the new head, the branch was pushed to a bare origin and `pr.open` returned a PR. The MCP round trip (initialize, tools/list, 11 tools) passes in `test/server.test.ts`. **Not met here:** a live model and a real GitHub PR. This container has no Pi logins, no provider keys and no `gh`. |
| B | Kill the daemon mid-run, restart, worker shows interrupted, steer resumes it, spend reported, reviewer comment on the PR | **Met with faux provider.** `test/e2e.test.ts` second case: running worker marked `interrupted` on restart, `worker.steer` resumed the same Pi session file to a succeeded result. Spend cap refusal, stop, review comment posting and `pr.merge` guards are covered in `test/helm.test.ts` with fakes. Live reviewer comment not run here. |
| C | Three workers in parallel visible from one terminal | **Met for the mechanics.** `helm ps`, `helm logs -f`, `helm status` and `GET /` on the daemon work against the store. Not exercised with three live workers. |

Evidence files: `helm/evidence/log.md`, `helm/test/e2e.test.ts`, test output below.

```
npx tsc --noEmit          clean
npm test                  77 tests, 77 pass, 0 fail   (52 at the first commit)
```

Continuation on 2026-09-18 (owner cleared up to 12 hours): an adversarial review found 14
confirmed defects, all fixed with regression tests; `owner/name` cloning, persisted context
paths, an HTML status page, and a simplification pass were added. Details in `log.md` and
`worklist.md`.

## 2. Spend

Zero. No model provider was called. All model traffic used Pi's in-process faux provider.

## 3. Line counts

| | Lines |
| --- | --- |
| `helm/src/*.ts` (12 files) | 2,341 |
| `helm/test/*.ts` (11 files) | 1,979 |

Old `src/` for comparison: 10,664 lines, 16 SQLite tables. New: 5 tables.

## 4. Gaps

- **Live proof.** Wave A and B live exit proofs need the owner's machine: `pi login` to a
  provider, `gh auth`, a target repo, and `HELM_SPEND_CAP_USD`. Run the four commands in the
  README's step 4.
- **`gh` transport untested against real `gh`.** `src/github.ts` is tested against a fake
  exec that records argv and parses sample JSON. The `gh pr create` URL parsing and
  `gh pr view --json` field names should be checked on first live use.
- **Stop is cooperative.** `worker.stop` aborts at the next tool call boundary; a model
  mid-generation finishes that generation first. If the turn never reaches a tool call the
  stop stays pending and the worker reports `unknown` until it settles.
- **Bash is not sandboxed.** The deny list blocks pushes, `gh`, worktree surgery and
  checkouts, and paths are contained for the file tools, but a worker's shell can still read
  outside the worktree. OS-level isolation is the operator's job.
- **`helm.ts` is 511 lines** against a 450 target after the simplification pass; the rest is
  contract boilerplate and the protected run loop.

## 5. Recommendations

1. Run the live Wave A proof on your machine with the free model first, then the builder model, before anything else.
2. Once live, retire `src/`, `test/` and the wave docs into a `legacy/` tag and make `helm/` the repo root.
3. Close issues #8, #10, #11, #27 as done and park the rest under one "deferred design" issue, as the assessment proposed.

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
