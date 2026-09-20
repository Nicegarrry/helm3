# One-shot brief: build the Helm harness

Audience: a local coding agent (Claude Code or Codex) running on the owner's machine with
Pi installed, Pi provider logins in `~/.pi/agent/auth.json`, and `gh` authenticated.
Date: 2026-09-18. Author: the owner, via an outside-in assessment of this repository.

Read this whole file before touching anything. It replaces the Brief, AGENTS.md and the
wave plans for the duration of this task. Where it conflicts with them, this file wins.

---

## 0. Fill in before starting

The owner sets these. Do not guess them. Stop and ask if any is blank.

| Setting | Value |
| --- | --- |
| Target repo for the acceptance run (owner/name, small, safe to open PRs on) | `__________` |
| Spend cap for this whole task, USD, all providers combined | `__________` |
| Builder model, provider/model as Pi names it (e.g. `opencode-go/qwen3.8-flash`) | `__________` |
| Reviewer model, a different family (e.g. `google/gemini-3.8-flash`) | `__________` |
| Free smoke model, synthetic content only (e.g. OpenRouter Nemotron `:free`) | `__________` |
| Branch to build on | `one-shot/helm` |

Standing rules carried over from the owner: no purchases, top-ups, plan changes or
account-wide settings changes. No ChatGPT worker other than Luna, and prefer none.
Credentials never enter the repo, a config file, or a log. The free route only ever sees
synthetic content, never private source.

---

## 1. North Star

One sentence. Everything you build serves it, nothing else.

> An orchestrator agent calls Helm tools; Helm runs Pi workers on cheap models in isolated
> worktrees, runs gates, opens PRs, and reports status durably, so the orchestrator spends
> almost no context on mechanics and a project can run for days at sensible cost.

The orchestrator is any agent that can call MCP tools: Claude Code, Codex, or a script.
Helm does not host the orchestrator and does not need an SDK driver for it.

---

## 2. Ground truth about this repository

This is what an outside-in assessment found on 2026-09-17. Verify anything you rely on.

What is real and tested (10.7k lines in `src/`, 383 passing tests):

- Git worktree isolation with an ownership row: `src/workspace/index.ts`.
- A gate runner that executes real checks at an exact SHA: `src/verification/index.ts`.
- GitHub issue reads and writes through the `gh` CLI: `src/tracker/index.ts:102-140`.
- An in-process Pi session returning a typed JSON `WorkerResult`: `src/runtime/pi/index.ts`,
  `src/contracts/index.ts:283-301`, `src/host/worker-result-format.ts`.
- A typed tool registry plus an MCP bridge for Fable and Astra: `src/runtime/orchestrator/`.
- An idempotent command journal that recovers to "unknown" on restart: `src/core/index.ts`.

What is missing or wrong against the North Star:

- No orchestrator loop. There is no `helm run` or `helm serve`. The only CLI runs one
  pre-authorised worker whose lease, grant and model facts must already be in SQLite.
- Workers cannot code. Pi's built-in tools are disabled at `src/runtime/pi/index.ts:353`.
  Builders get a single `helm_write` tool, reviewers a single `helm_read`. A builder cannot
  read the file it edits, grep, or run tests.
- No PR creation and no push anywhere in `src/`.
- Every model call and file write is a kernel command with a USD upper-bound reservation
  and three SQLite transactions. Unresolved reservations blocked all worker slots.
- Supervisor and wake dispatcher are only composed in tests.
- The cockpit is a static status page where most cards are hard-coded unknown.
- 16 SQLite tables, three lease and grant tiers, a versioned model registry, an economy
  module, an artifact journal with three sidecars. None of this serves the North Star.

Decision already taken by the owner: do not prune in place. Build a fresh package and copy
the good modules into it. Leave `src/`, `test/` and `docs/` untouched except as noted in
section 9.

---

## 3. Deliverable

A new package at `helm/` in this repository with its own `package.json`, exposing:

1. `helm serve` : a long-running daemon that owns workers and exposes the tools below over
   MCP (stdio, for Claude Code `.mcp.json`) and Streamable HTTP on `127.0.0.1` (for Codex
   and for the CLI).
2. `helm` CLI : `spawn`, `ps`, `logs <id> [-f]`, `inspect <id>`, `steer <id> "<msg>"`,
   `stop <id>`, `gate <id>`, `pr <id>`, `review <id|pr#>`, `status`, `serve`.
   Reads open SQLite directly and work without the daemon. Writes call the daemon over
   loopback HTTP and fail with a clear message if it is not running.
3. A `README.md` in `helm/` that a human can follow in five minutes: install, log in to Pi,
   start `helm serve`, add to `.mcp.json`, run one task.

Target size: 2k to 3k lines of TypeScript including tests. If you pass 4k, stop and cut.

Stack: Node 22 (use `node:sqlite`, already used by the old code), TypeScript, `tsx`,
`zod`, `@modelcontextprotocol/sdk` 1.30, `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-ai` at the versions pinned in the root `package.json`. No web framework.

---

## 4. Tool surface

Ten tools. Same names and schemas on MCP and CLI. Every tool returns
`{ ok: true, ...value }` or `{ ok: false, reason }`. Never throw across the boundary.

| Tool | Input | Output |
| --- | --- | --- |
| `worker.spawn` | `repo` (path or owner/name), `objective`, `acceptance?`, `model`, `baseRef?` (default: default branch), `role?` (`builder`, default), `contextPaths?` | `workerId`, `branch`, `worktree` |
| `worker.inspect` | `workerId`, `tail?` (events, default 20) | `state`, `model`, `branch`, `head`, `spendUsd`, `tokens`, `diffStat`, `result?`, `events[]` |
| `worker.list` | `repo?`, `state?` | `workers[]` (one line each) |
| `worker.steer` | `workerId`, `message` | `turn` (refused if the worker is running) |
| `worker.stop` | `workerId` | `state` (`stopped` or `unknown`) |
| `gate.run` | `workerId`, `checks?` (defaults from repo config) | `head`, `passed`, `checks[]` with exit codes and captured output paths |
| `pr.open` | `workerId`, `title?`, `body?`, `draft?` | `number`, `url`, `head` |
| `pr.status` | `number` or `workerId` | `state`, `mergeable`, `checks[]`, `reviews[]`, `head` |
| `review.request` | `workerId` or `number`, `model` | `reviewWorkerId`; on completion Helm posts the verdict as a PR comment and stores it |
| `run.status` | none | `spendUsd`, `spendCapUsd`, `activeWorkers`, `maxWorkers`, `unknownCostEvents` |

Worker states: `queued`, `running`, `idle` (finished a turn, steerable), `succeeded`,
`failed`, `stopped`, `interrupted` (daemon died while running), `unknown`.

Not tools, on purpose: the issue Map, leases, budgets, model registry, consultation,
failover, brief reading. The orchestrator uses `gh` directly for issues.

---

## 5. Worker runtime

Copy and shrink `src/runtime/pi/index.ts`. Keep: session creation, prompt, result parsing,
one correction turn for a malformed result, abort. Drop: the `streamSimple` proxy,
reservations, fork and rehydrate, manual compaction, stop receipts.

- Create the session with `createAgentSession({ cwd: worktree, ... })` and Pi's built-in
  tools enabled: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- Credentials: use Pi's default `ModelRuntime` so the owner's existing logins in
  `~/.pi/agent/auth.json` work. Never copy credentials anywhere.
- Register a `tool_call` extension hook (see
  `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`) that
  refuses: any path outside the worktree, writes under `.git/`, writes under
  `.github/workflows/` unless the spawn allowed it, and bash commands matching
  `git push`, `gh `, `git worktree`, `git checkout` of another branch, `rm -rf /`.
  This is the whole protected-path policy. Log refusals as events.
- Reviewer role: same session, but the hook refuses `edit`, `write` and bash writes. The
  reviewer runs in its own worktree at the PR head.
- The prompt ends with the `WorkerResult` instruction. Reuse the schema from
  `src/contracts/index.ts:283-301`, simplified to: `status` (`succeeded`, `failed`,
  `partial`), `summary`, `changedFiles[]`, `commandsRun[]`, `notes?`. Accept strict JSON
  or one fenced JSON block. One correction turn, then mark `failed` with the raw text saved.
- Commit the worktree on success with the worker's summary as the message. Workers never
  push; `pr.open` pushes.
- Spend: subscribe to Pi usage events, multiply tokens by the model's price from Pi's
  catalogue, accumulate per worker and per run. Unknown price: count tokens, increment
  `unknownCostEvents`, do not block. Cap reached: refuse new spawns, abort running workers
  at the next turn boundary. This replaces the entire economy and reservation design.

---

## 6. Storage and durability

One SQLite file at `$HELM_HOME/helm.sqlite` (default `~/.helm`), worktrees under
`$HELM_HOME/worktrees/<repoSlug>/<workerId>`, captured output under
`$HELM_HOME/logs/<workerId>/`. Five tables: `workers`, `events`, `gates`, `prs`, `spend`.
Append-only events with a monotonic id per worker.

Restart rule: on daemon start, every worker in `running` becomes `interrupted` with its Pi
session file path recorded. `worker.steer` on an interrupted worker resumes that session
with Pi's `SessionManager`. Nothing is replayed automatically. Idempotency: `worker.spawn`
takes an optional `idempotencyKey`; a repeat returns the existing worker.

Reuse from the old code by copying: worktree create and remove from
`src/workspace/index.ts`, `runGate` and `classifyCi` from `src/verification/index.ts`,
`ghCommandTransport` from `src/tracker/index.ts`, the registry class from
`src/runtime/orchestrator/index.ts`, and `astra-loopback-mcp.ts` for the HTTP transport
if it fits; otherwise use the MCP SDK's Streamable HTTP server directly.

---

## 7. Waves, in order, with exit proofs

Do them in order. Commit at the end of each wave. Do not start the next wave until the
exit proof has actually run on this machine and its output is saved under
`helm/evidence/`.

**Wave A, the loop closes (time box 3 hours).**
Build `helm serve`, the ten tools, the worker runtime, `gate.run`, `pr.open`, `pr.status`,
the CLI. Unit tests with Pi's faux provider for spawn, result parsing, hook refusals,
restart marking and idempotency.
Exit proof: from a fresh Claude Code session with Helm in `.mcp.json`, the orchestrator
calls `worker.spawn` against the target repo with the builder model, polls
`worker.inspect`, calls `gate.run`, calls `pr.open`, and a real PR exists on GitHub with a
green gate recorded at its head SHA. No human touched SQLite or the worktree. Save the
tool call transcript and the PR URL.

**Wave B, durable and cheap (time box 2 hours).**
Spend accounting and cap, `review.request` with the reviewer posting a PR comment,
`worker.stop`, interrupted-then-steer resume, and `pr.merge` guarded by exact head and green
`pr.status` (add it as an eleventh tool only if Wave A is done).
Exit proof: kill `helm serve` while a worker is running, restart, the worker shows
`interrupted`, `worker.steer` resumes it to a result, nothing duplicated, `run.status`
shows the spend. A reviewer comment from the reviewer model is on the Wave A PR.

**Wave C, watchable (time box 1 hour).**
`helm ps` and `helm logs -f` streaming from the events table, `helm status`, and the
README. Optional: one server-rendered HTML page at `/` on the HTTP port showing the same
data as `helm ps`. No JavaScript framework.
Exit proof: with three workers running in parallel on the target repo, one terminal shows
what each is doing and its spend.

Order of model use: smoke everything on the free model with a synthetic task in a scratch
worktree first. Then the builder model for the real Wave A task. The reviewer model only in
Wave B. Report every provider error verbatim; a 429 is a fact, not a flake.

---

## 8. Non-goals

Do not build, and do not leave hooks for: autonomy leases, human grants, orchestrator
epochs, economy pools, model registry with versions, artifact journal sidecars,
supervisor wakes, Fable or Astra SDK drivers, consultation, failover, calibration, a
Next.js or Bun web app, Map mutation tools. If you find yourself adding a table beyond the
five, stop and write down why in the report instead.

---

## 9. Working method

- Work on branch `one-shot/helm` from `main`. You are the only writer. Commit after each
  wave with a plain message. Push the branch. Open one draft PR at the end titled
  "helm: one-shot harness (waves A to C)". Do not merge it.
- Do not modify `src/`, `test/` or existing `docs/`. Add `helm/` to the root CI workflow
  as a separate job running `npm test` in `helm/`.
- Keep a running log at `helm/evidence/log.md`: what ran, exact commands, provider,
  model, tokens, cost, wall time, and every refusal or error.
- If a wave's exit proof cannot be met inside its time box, stop that wave, write why in
  the log, and move on. Report the gap. Do not widen scope to get around it.
- If the spend cap in section 0 is reached, stop all model use and report.

---

## 10. Report back

When done, or when stopped, write `helm/evidence/report.md` with, in this order:

1. Which exit proofs passed, with the PR URL and the evidence file names.
2. Spend: total USD, per model, tokens, and how many events had unknown cost.
3. Line counts for `helm/` split by source and tests.
4. Gaps: anything in sections 3 to 7 not delivered, and why.
5. Three recommendations for what the owner should decide next, one line each.
6. A proposed replacement for the root `AGENTS.md` (under 40 lines) that describes the
   new harness and retires the lease ledger. Do not apply it; the owner will.
