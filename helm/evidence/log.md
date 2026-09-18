# Helm one-shot build log

Environment: Claude Code remote container (Linux, Node 22.22.2), no `gh` binary, no Pi
logins (`~/.pi/agent/auth.json` absent), no provider API keys in the environment. All
model-backed tests therefore use Pi's packaged faux provider. Live-model and real-PR
exit proofs are deferred to the owner's machine; see `report.md`.

Coordinator: Claude (Fable 5.1) in this session. Builders: three Sonnet subagents on
disjoint files, per `DESIGN.md`. Branch: `claude/helm3-assessment-simplify-qsdefo`
(the session's designated branch; the brief's `one-shot/helm` name was not used because
this session may only push to its designated branch).

## 2026-09-18 09:20Z  Scaffold

- `helm/package.json`, `tsconfig.json`, `bin/helm.js`, `src/types.ts` (contracts),
  `DESIGN.md` (module map). `helm/node_modules` is a symlink to the root `node_modules`
  so the harness uses the same pinned Pi, MCP and zod versions as the old code.
- CI: added a `helm-harness` job to `.github/workflows/core.yml`.

## 2026-09-18 09:30Z  Wave A build, three parallel Sonnet workers

- Worker 1: `config.ts`, `store.ts`, `workspace.ts`, `gate.ts`, `github.ts` + tests.
- Worker 2: `worker.ts`, `prompt.ts` + faux-provider tests.
- Worker 3: `helm.ts`, `tools.ts`, `server.ts`, `cli.ts` + fake-backed tests.

## 2026-09-18 09:50Z  Workers landed

- Worker 1: 549 source lines, 23 tests green, no contract change.
- Worker 2: 346 source lines, 8 tests green. `tool_call` hook registered by loading an
  inline extension through `loadExtensionFromFactory` and a custom `ResourceLoader`; the
  loader is reached through `import.meta.resolve` because it is not on the package's
  exports map. Block result shape `{ block: true, reason }` confirmed to surface to the model.
- Worker 3: 1,089 source lines, 19 tests green. `helm.ts` and `cli.ts` over soft targets.

## 2026-09-18 10:00Z  Integration (coordinator)

- `npx tsc --noEmit` clean across the package; `npm test` 50/50.
- Wrote `test/e2e.test.ts` on the real composition. Found and fixed one bug: `openStore`
  did not create its parent directory, so a fresh `HELM_HOME` failed. Fixed in `store.ts`.
- e2e case 1: spawn on a temp repo with a bare origin; faux Pi issues `write hello.txt`,
  then `bash git push origin HEAD` (refused by hook, `tool.refused` event), then a JSON
  result. Helm committed, gate `test -f hello.txt` passed at the new head, branch pushed to
  origin, fake `gh` opened PR 7, daemon `/tools/worker.list` and `GET /` show the worker.
- e2e case 2: worker row forced to `running`, store reopened, `markInterruptedOnStart`
  returns the id, `worker.steer` resumes the saved Pi session file to `succeeded`.
- CLI by hand with a temp `HELM_HOME`: `ps`, `status`, `spawn` without daemon (clear
  message), `serve --http --port 47391` then `GET /`, `POST /tools/run.status`,
  `POST /tools/worker.inspect` (not found -> ok:false), clean shutdown.
- Final: 52/52 tests, typecheck clean. `python3 scripts/check-preparation.py` still valid.
- Spend: US$0. No provider was contacted.
