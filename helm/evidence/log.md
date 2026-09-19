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

## 2026-09-18 10:30Z  Continuation (owner cleared up to 12h; hourly self-wake routine set)

- Item 2: `contextPaths` and `allowWorkflows` persisted on the worker row; steer/resume reuse them.
- Item 3: `gh` usage verified. Docs sites are blocked by the egress proxy; corroborated via web
  search. One real fix: `mergeable: UNKNOWN` was mapped to `false`, now `null`.
- Item 4: `worker.spawn` accepts `owner/name`; clones once under `$HELM_HOME/repos` with
  `gh repo clone` (https fallback), fetches on reuse.
- Item 1: Sonnet adversarial review produced 14 confirmed findings. All fixed by two Sonnet
  workers on disjoint files, each with a regression test. Highlights: stop signal lost on
  timeout (F1); concurrent steer on one worktree (F2); spend cap not enforced on steer (F3);
  symlink escape through the write tool for not-yet-existing paths (F4); git deny regexes
  bypassed by inserted flags such as `git -C .. push`, replaced with a tokenizer (F5);
  spawn admission races, now behind an in-process mutex (F6); stop overwrote a naturally
  reached terminal state (F7); gate check names used unsanitised in log paths (F8);
  correction turn ignored stop and cap (F9); result parser tried only the last fence (F10);
  quoted `cd` bypass (F11); no HTTP body limit and 500 on bad JSON (F12); stale serve.json
  and no single-instance guard (F13); `updatedAt` never refreshed (F14).
- Items 7, 8: `.mcp.example.json`, root README pointer; CI green on the branch.
- After fixes: 74 tests, typecheck clean; src 2,482 lines, tests 1,945 lines.

## 2026-09-18 10:45Z  Items 5 and 6

- Simplify pass (behaviour preserving, no test changes): `helm.ts` 604 -> 511, `cli.ts` 367 -> 267.
- `GET /` renders a small auto-refreshing HTML page when `Accept: text/html`; plain text
  otherwise. `GET /api/status` added. README updated for clone-on-demand, watching, and the
  sandbox caveat.
- Final: 77 tests, typecheck clean; src 2,341 lines, tests 1,979 lines. Spend: US$0.

## 2026-09-18 10:50Z  Close-out

- Draft PR #138 opened from the branch with the repo's PR template sections filled in.
- Worklist complete. Self-wake routine deleted after confirming CI on the final head.

## 2026-09-19 00:10Z  Stdio MCP proof

- Drove `helm serve --stdio` as a child process with the real MCP SDK client: tools/list
  returned all 11 tools; tools/call worked for run.status and worker.inspect; an invalid
  input surfaced as an MCP validation error. Added `test/mcp-stdio.test.ts`. 78 tests green.

## 2026-09-19 06:50Z  Read-only dashboard

- `helm.overview()` read method: run status, every worker with spend, tokens, elapsed, head,
  objective and last event, plus a per-model rollup. Served as HTML at `GET /` (Accept:
  text/html) and JSON at `GET /api/state`. `serve --stdio` now also binds the loopback page
  and prints its URL to stderr. Screenshot checked with headless Chromium. 79 tests green.

## 2026-09-19 07:00Z  Live dashboard

- `src/ui.ts`: single-page read-only dashboard, inline vanilla JS, polls `/api/state` and
  `/api/events` every 2s (paused when hidden), worker detail drawer from `/api/worker/<id>`
  with deep links (`#w-<id>`), filters, per-model rollup, spend timeline on canvas against
  the cap, live event stream. Backend: `Helm.workerDetail`, `Helm.recentEvents`,
  `Store.listAllEvents`, `Store.spendSeries`, `spendSeries` in `overview()`.
- Verified against a seeded daemon with headless Chromium screenshots (light, dark, drawer).
- 91 tests green, typecheck clean.

## 2026-09-19 07:45Z  Dashboard restyle

- System sans-serif stack (SF Pro on Apple devices), cards, stat tiles, tinted state badges,
  segmented filter control, Apple-style light and dark palettes with a `?theme=` override.
  Monospace kept for ids, hashes and event kinds only. Screenshots checked in light and dark,
  with the drawer open. 91 tests green.

## 2026-09-19 08:05Z  Review independence and soft spend cap

- `review.request` refuses the builder's exact model and any model of the same family
  (leading letters of the model id after provider and vendor prefixes); `allowSameFamily`
  overrides. `modelFamily()` exported and unit tested.
- Soft cap `HELM_SPEND_WARN_USD`, default 80% of the hard cap. Crossing it appends a
  `spend.warning` event, sets `aboveSoftCap` and `spendWarnUsd` in `run.status`, adds a
  `warning` field to spawn and steer results, and turns the dashboard bar amber. Never blocks.
- Confirmed Pi 0.85.1 ships an `openai-codex` provider (ChatGPT/Codex OAuth) alongside
  `opencode-go`, `openrouter` and `github-copilot`, so Codex workers need no native harness.
- 95 tests green.

## 2026-09-19 08:00Z  Liquid Glass restyle

- Translucent frosted cards with backdrop blur and a specular inner edge, concentric large
  radii, capsule segmented control and badges, soft gradient backdrop, large bold title, and
  a floating glass drawer. CSS only; light and dark verified by screenshot.
