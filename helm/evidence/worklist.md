# Continuation worklist

Authority: on 2026-09-18 the owner cleared this session to run until the list is complete
or until 2026-09-18T22:10Z (12 hours), resuming automatically after usage-limit stops.
No keys or Pi logins exist in this environment, so nothing here contacts a model provider
or GitHub with credentials. Update the status column as items finish; each wake reads it.

| # | Item | Status |
| --- | --- | --- |
| 1 | Coordinator code review of `helm.ts`, `worker.ts`, `cli.ts`, `server.ts`, `store.ts`; fix real bugs found | done (14 findings, all fixed with regression tests) |
| 2 | Persist `contextPaths` and `allowWorkflows` on the worker row so steer and resume reuse them | done |
| 3 | Verify `gh pr create` / `gh pr view --json` field names in `github.ts` against GitHub CLI docs (WebFetch); fix mismatches | done (docs blocked by egress; corroborated by web search; one mapping fix) |
| 4 | `worker.spawn` accepts `owner/name`: clone into `$HELM_HOME/repos/<slug>` on first use, then treat as a local path | done |
| 5 | Simplify pass on `helm.ts` and `cli.ts` toward their size targets without behaviour change | done (helm.ts 604->511, cli.ts 367->267) |
| 6 | Wave C optional: `GET /` returns a small server-rendered HTML page (auto-refresh) with the same data as `helm ps` | done (plus GET /api/status) |
| 7 | Add `helm/.mcp.example.json` and a root `README.md` pointer to `helm/` | done |
| 8 | Confirm the `helm-harness` CI job is green on the branch; fix if red | done (Core validation runs 506, 507 green; re-check after final push) |
| 9 | Open one draft PR titled "helm: one-shot harness (waves A to C)" as the brief instructs; do not merge | todo |
| 10 | Final: update `report.md`, delete the self-wake routine | todo |

Rules for each wake: run `npm test` and `npx tsc --noEmit` in `helm/` before every push;
commit per item with a plain message; push to `claude/helm3-assessment-simplify-qsdefo`
only; never touch old `src/`, `test/` or existing `docs/`; stop at the deadline even if
items remain and record what is left in `report.md`.
