# Helm harness: module map

Read `docs/one-shot-brief.md` first. `src/types.ts` is the contract; do not change it
without telling the coordinator. All modules are ESM TypeScript run by `tsx` on Node 22.
Use `node:sqlite` (built in), `node:child_process` with `execFile` (never `shell: true`),
`zod` v4 (`import { z } from 'zod'`). Tests use `node:test` and `node:assert/strict`, live
in `test/<module>.test.ts`, and must run with `npm test` from `helm/`.

| File | Owns | Exports |
| --- | --- | --- |
| `src/types.ts` | contracts | see file |
| `src/store.ts` | SQLite, five tables, events, restart marking | `openStore(path): Store` |
| `src/workspace.ts` | git worktree add/remove, commit, push, diff stat | `gitWorkspace(): Workspace` |
| `src/gate.ts` | run checks as child processes, capture output | `gateRunner(): GateRunner` |
| `src/github.ts` | `gh` CLI transport: pr create, status, comment, merge | `ghGitHub(exec?): GitHub` |
| `src/worker.ts` | Pi session runtime, tool hook, result parsing, usage | `piWorkerRunner(opts): WorkerRunner` |
| `src/prompt.ts` | builder and reviewer prompt text and the result instruction | `buildPrompt(...)`, `RESULT_INSTRUCTION` |
| `src/helm.ts` | the service: composes the above, implements the ten tools | `class Helm` |
| `src/tools.ts` | tool registry: names, zod inputs, dispatch to `Helm` | `createToolRegistry(helm)` |
| `src/server.ts` | `helm serve`: MCP stdio + Streamable HTTP on 127.0.0.1 | `serve(opts)` |
| `src/cli.ts` | `helm` command line | main |
| `src/config.ts` | `$HELM_HOME`, spend cap, max workers | `loadConfig(env)` |

Storage layout: `$HELM_HOME/helm.sqlite`, `$HELM_HOME/worktrees/<repoSlug>/<workerId>`,
`$HELM_HOME/logs/<workerId>/`, `$HELM_HOME/sessions/<workerId>/`.

Worker id: `w-` + 8 hex chars. Branch: `helm/<workerId>`.

Events are the only log. Kinds used by `helm.ts` and `worker.ts`:
`spawned`, `state` ({from,to}), `turn.start` ({message}), `turn.end`, `tool.call`
({tool, summary}), `tool.refused` ({tool, reason}), `usage` (SpendRow fields), `result`
(WorkerResult), `result.invalid` ({rawText}), `error` ({message}), `gate` ({gateId,passed}),
`pr` ({number,url}), `stop.requested`.

Tool outcomes never throw across the MCP or HTTP boundary: `{ ok: true, ... }` or
`{ ok: false, reason }`.
