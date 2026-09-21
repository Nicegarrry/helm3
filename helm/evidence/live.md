# Live proof log

The faux-provider run in `report.md` proved the mechanics. This file records what was proven
against real models, a real `gh` and a real GitHub repository.

- **Date:** 2026-09-20
- **Machine:** macOS 27.0, arm64 (Apple Silicon), Node v22.22.2, Pi 0.85.1, pnpm 11.4.0
- **Checkout:** worktree of `claude/helm3-assessment-simplify-qsdefo` at
  `~/code/other/helm3-local-handoff`, `helm/node_modules` symlinked to the repo root's
- **`HELM_HOME`:** `~/.helm` · **`HELM_SPEND_CAP_USD`:** `5`
- **Target repo:** `~/code/web/brief` (`Nicegarrry/brief`)

## Models

| Role | Model as Pi names it | Notes |
| --- | --- | --- |
| Free smoke | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | Synthetic scratch repo only |
| Builder | `opencode-go/qwen3.8-flash` | The model the handoff named |
| Reviewer | `google/gemini-3.8-flash` | Different family from the builder |

The handoff's preflight table expected `opencode-go/qwen3.8-flash`. At first run the
`opencode-go` provider was not logged in, so `pi --list-models` showed only `google` and
`openrouter`; the owner logged into OpenCode mid-run and the intended model became available
and was used.

## Preflight

```
node --version                         v22.22.2
cd helm && npm test                    95 tests, 95 pass, 0 fail
npx tsc --noEmit                       clean
gh auth status                         Logged in to github.com account Nicegarrry
```

`gh` was initially reported as an invalid token; the owner re-ran `gh auth login` before
section 2.3.

## Fix 1 — `defaultModelRuntime` disabled the operator's model config

**Symptom.** The first free-model spawn (`w-46658c27`) failed one second after `turn.start`:

```
error {"message":"No API key found for openrouter.\n\nUse /login to log into a provider..."}
state {"from":"running","to":"unknown"}
```

**Cause.** `helm/src/worker.ts` built its model runtime with `modelsPath: null`:

```ts
return ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
```

In `@earendil-works/pi-coding-agent`, `modelsPath: null` resolves to `undefined` and
`ModelConfig.load(undefined)` loads nothing; the default is `~/.pi/agent/models.json`
(`dist/core/model-runtime.js:76`). That file is where custom providers, their API keys and
pinned routes live. Every model configured there was therefore unresolvable, and built-in
models of a configured provider had no credential.

Measured directly, before changing anything:

| Model | `modelsPath: null` | default `modelsPath` |
| --- | --- | --- |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | found, no credential | found |
| `openrouter/deepseek/deepseek-v4.1-flash` | **not found** | found, cost `0.3/1.2` |
| `google/gemini-3.8-flash` | found | found |

The middle row is the operator's ZDR/Baseten-pinned route. Under the old line Helm could not
run it at all, and its catalogue prices — which is what spend is summed from — were invisible.

**Fix.** Leave `modelsPath` unset so Pi loads the operator's `models.json`; keep
`allowModelNetwork: false` and `refreshOnCreate: false`. `defaultModelRuntime` is now exported
so it can be tested.

**Regression test.** `test/worker.test.ts`, "defaultModelRuntime loads the operator models.json
so configured providers resolve": writes a `models.json` declaring a provider that exists
nowhere else, points `PI_CODING_AGENT_DIR` at it, and asserts the model resolves. Verified to
fail with the old line (`not ok 1`) and pass with the new one. Suite: 95 → 96 tests.

## Wave A — the loop closes

### A1. Daemon

```
HELM_SPEND_CAP_USD=5 HELM_HOME=~/.helm ./helm/bin/helm.js serve --http --port 4747
helm serve listening on http://127.0.0.1:4747
```

`~/.helm/serve.json` → `{"port":4747,"pid":…}`. `curl http://127.0.0.1:4747/` returns the
plain `helm ps` table; the browser dashboard was open throughout.

`~/.helm` already held `ledger.db` from the old control plane. The new store is `helm.sqlite`,
so the two do not collide.

### A2. Free-model smoke, synthetic content only

Scratch repo created locally: `git init` + `README.md` + a `helm.json` gate of
`test -f hello.txt`. No private code.

```
helm spawn --repo <scratch> \
  --objective "Create a file named hello.txt in the repository root containing a short friendly greeting. Nothing else." \
  --model openrouter/nvidia/nemotron-3-ultra-550b-a55b:free
→ w-236e5095, branch helm/w-236e5095
```

Tool calls recorded in the event log: `ls`, `write`, `read`. Result `succeeded`. Helm committed
the worker's change to head `56a8b9e`, diff `hello.txt | 3 +++`.

```
helm gate w-236e5095
→ passed: true, head 56a8b9e, check "hello-exists" exit 0 in 5ms
```

Spend: **$0.0000** (free route).

### A3. Real task, real model, real PR

Target `~/code/web/brief`. Gate configured in `~/code/web/brief/helm.json`:

```json
{ "gates": [
    { "name": "install", "command": "pnpm install --frozen-lockfile --prefer-offline" },
    { "name": "unit",    "command": "pnpm vitest run --project unit" } ] }
```

Chosen because brief's default `package.json` gates cannot pass on a fresh checkout: `pnpm test`
runs both vitest projects and the 22 `convex` files need generated bindings
(`Cannot find module './_generated/api'`), which `pnpm codegen` produces by starting a local
Convex. The `unit` project is 152 files / 2,693 tests and is green on `main`. `helm.json` is read
from the **source repo**, not the worktree (`gate.ts` `defaultChecks(row.repo)`), so no commit to
brief was needed to configure it.

Task: `packages/shared/src/targets.ts` carries an `SG-9` comment that says
"`targets.test.ts` pins it" — and no such file exists. The worker was asked to write it and to
change nothing else.

```
helm spawn --repo ~/code/web/brief --model opencode-go/qwen3.8-flash --objective "…" --acceptance "…"
→ w-5445a1ae, branch helm/w-5445a1ae
```

The worker read `targets.ts`, `ids.ts` and the sibling `ids.test.ts`, ran
`pnpm install --frozen-lockfile --prefer-offline`, wrote the file, then ran the targeted vitest
command, the full `unit` project, `prettier --check`, `eslint` and `tsc --noEmit` itself before
reporting. Result `succeeded`, head `96d59be`, diff
`packages/shared/src/targets.test.ts | 142 ++++`, one file, no existing file touched.

The test it produced follows brief's own convention of citing ticket ids, and pins the `SG-9`
omission by name — asserting that a `sug_` id *does* match `ID_PATTERN` while `targetKind`
still returns `null`, which is the half that would silently break if someone "fixed" the missing
`case 'sug'`.

```
helm gate w-5445a1ae
→ passed: true, head 96d59be
  install  exit 0    332ms
  unit     exit 0  17,311ms   (2,709 passed | 2 skipped)

helm pr w-5445a1ae --draft --title "test(shared): add the targets.test.ts that SG-9 promises"
→ { ok: true, number: 248, url: https://github.com/Nicegarrry/brief/pull/248, head: 96d59be }
```

**`src/github.ts` worked against real `gh` on first contact — no fix was needed.** The
`gh pr create` URL parsing returned the right number, and `gh pr view --json` field shapes
parsed correctly, including the checks array:

```
helm pr-status w-5445a1ae
→ state open, mergeable true, head 96d59be
  "lint · typecheck · test · build"  QUEUED
  "Vercel"                           SUCCESS
  "Vercel Preview Comments"          COMPLETED / SUCCESS
```

Confirmed independently with `gh pr view 248 --repo Nicegarrry/brief --json …`: draft, open,
head `96d59bee42de5ef358e83ec5dfb21c086f8eeeaa`, one file
`packages/shared/src/targets.test.ts` `+142/-0`.

Spend after Wave A: **$0.009541** total, all of it the builder; 4 unknown-cost events.

### Observation — `helm status` does not show the cap

`run.status` from the CLI reported `"spendCapUsd": 0` while the daemon was running with
`HELM_SPEND_CAP_USD=5`. The cap is read from the environment of whichever process answers, and
the CLI reads the store directly rather than asking the daemon. Spend itself is correct. See
Wave B3 for whether enforcement is affected.

## Fix 2 — a killed turn left nothing to resume from

**Symptom.** Wave B2, first attempt. The daemon was killed with SIGINT while `w-d4dfd1bf` was
mid-turn, restarted, and correctly showed `interrupted`. But `helm steer` produced a **second**
Pi session file, and the resumed worker had lost the objective: asked to create `a.txt`,
`b.txt` and `c.txt`, it reported "Created hello.txt to satisfy the 'hello-exists' gate in
helm.json" — a goal it invented from the repo, because it started with no context.

```
~/.helm/sessions/w-d4dfd1bf/
  2026-09-20T08-16-32-941Z_…jsonl   14 entries   (before the kill)
  2026-09-20T08-17-02-858Z_…jsonl   18 entries   (after the steer — a new session)
```

**Cause.** `helm/src/helm.ts` recorded the session file only from the turn's outcome:

```ts
this.store.updateWorker(workerId, { state: nextState, sessionFile: outcome.sessionFile ?? row.sessionFile, … });
```

A turn that is killed never returns an outcome, so `sessionFile` stayed `null`, and
`runTurn` then passed `sessionFile: null` into the runner, which takes the
`SessionManager.create()` branch instead of `SessionManager.open()`. The durability feature
failed in exactly the case it exists for.

**Why the faux-provider test missed it.** `test/e2e.test.ts` says it leaves the worker
"in 'running' by writing the row directly, as a crash would" — but it first lets the turn
*complete* (`await helm.settle(...)`, state `idle`), which persists `sessionFile`, and only
then flips the row back to `running`. It reproduces a crash's **state** but not its **timing**,
so line 155's `assert.ok(…sessionFile, 'session file recorded for resume')` was always
satisfied by the completed run.

**Fix.** A new `onSession(sessionFile)` hook on `WorkerHooks`. `piWorkerRunner` calls it
immediately after `SessionManager.open`/`create`, from `sessionManager.getSessionFile()`, and
`Helm.runTurn` writes it to the store there and then. The end-of-turn write now falls back to
what the store holds rather than to the pre-turn `row`, which would otherwise reinstate the
stale `null`.

**Regression tests** (all three verified to fail without the fix):
- `helm.test.ts` — "a turn killed before it returns still leaves a session file to resume from":
  a runner that reports a session then throws; the row must still carry the path.
- `helm.test.ts` — "the end-of-turn write does not reinstate a session file that predates
  onSession".
- `worker.test.ts` — "the Pi session file is reported as soon as it is opened, before any model
  traffic": asserts `onSession` fires once, matches the outcome's path, and is ordered before
  the first usage event.

Suite: 96 → 99 tests. `src/*.ts` 2,798 → 2,817 lines.

## Wave B — durable and cheap

### B1. Cross-family review on the real PR

```
helm review w-5445a1ae --model google/gemini-3.8-flash
→ { ok: true, reviewWorkerId: "w-c37ea58f" }
```

The reviewer ran read-only (`changedFiles: []`) and its own commands: `git diff origin/main..`,
the targeted vitest file, `prettier --check`, `eslint`, `pnpm --filter @brief/shared typecheck`,
`pnpm vitest run --project unit`, `pnpm lint`. Verdict `APPROVE`, posted as
`review.posted {"number":248}` and confirmed on GitHub with
`gh pr view 248 --json comments` — a comment by `Nicegarrry` carrying the verdict text.

The family guard was exercised in both directions, and refused both times without spawning:

```
helm review w-5445a1ae --model opencode-go/qwen3.8-max
→ { ok: false, reason: "reviewer model family 'qwen' matches the builder's; pick another family or pass allowSameFamily" }

helm review w-5445a1ae --model opencode-go/qwen3.8-flash
→ { ok: false, reason: "reviewer must not be the builder's model (opencode-go/qwen3.8-flash)" }
```

`allowSameFamily` was never passed.

### B2. Kill and resume (re-run after Fix 2)

Worker `w-4d39960b`, four files to write, free model.

```
# mid-turn, before the kill — the session file is already recorded:
sessionFile: /Users/sa/.helm/sessions/w-4d39960b/2026-09-20T08-22-02-114Z_…jsonl

kill -INT <daemon pid>        # Ctrl-C
helm ps                       # still 'running' — a stale row, the daemon is gone
<restart daemon>
helm ps                       # w-4d39960b  interrupted
helm steer w-4d39960b "Continue and finish."   → { ok: true, turn: 1 }
```

After the resume there is still exactly **one** session file, and the worker restated the
original objective rather than inventing one:

> "Created four files (one.txt, two.txt, three.txt, four.txt) in the repository root, each
> containing a single sentence naming its number. Read each file back after writing to confirm
> contents."

`helm gate` passed at the resulting head `6bf34ed`.

### B3. Soft cap, then hard cap

The soft cap is crossed *during* a run and never blocks:

```
HELM_SPEND_WARN_USD=0.2135   (spend at the time: $0.21331)
spend.warning {"spendUsd":0.21381,"spendWarnUsd":0.2135,"spendCapUsd":5}
GET /api/state → run.aboveSoftCap: true      (the dashboard bar turns amber)
```

and the next spawn carries it back to the orchestrator:

```
helm spawn … → { ok: true, workerId: "w-72d8373a", …, "warning": "spend is above the soft cap of $0.21" }
```

The hard cap refuses:

```
HELM_SPEND_CAP_USD=0.10      (spend at the time: $0.21480)
helm spawn … → { ok: false, reason: "spend cap reached" }
```

### Correction to the Wave A observation

`helm status` from the CLI reports `spendCapUsd: 0` because the CLI reads the store with its
own environment, and the cap lives in the environment of whichever process holds it. The
daemon's own view is correct — `GET /api/state` returned `spendCapUsd: 5`, `spendWarnUsd: 0.22`
while the CLI showed `0`. **Enforcement is not affected**: the refusal above came from a daemon
started with the low cap. This is a reporting wrinkle in the CLI, not a cap defect.

## Wave C — watchable

`HELM_MAX_WORKERS=3`, three builders spawned back to back on `~/code/web/brief`, each writing a
missing test file for a different untested module in `packages/shared/src`.

| Worker | Target | Spend | Result |
| --- | --- | --- | --- |
| `w-4713f07b` | `scalars.test.ts` | $0.0035 | 64 lines, 7 tests |
| `w-ebd7b6cb` | `palette.test.ts` | $0.0059 | 151 lines, 12 tests |
| `w-c1253fff` | `boardComments.test.ts` | $0.0121 | 195 lines, 12 tests |

Screenshot with all three running: `helm/evidence/live-dashboard.png`. It shows
`WORKERS 3 / 3 active`, `SPEND $0.2186 / $5.00 cap`, the per-model rollup
(`google/gemini-3.8-flash` 1 worker $0.2030, `opencode-go/qwen3.8-flash` 6 workers 3 active
$0.0156, the free nemotron 5 workers $0.0000), the cumulative spend timeline against the cap,
and the live event stream interleaving all three workers' tool calls.

The only console output on the page is a `404` for `/favicon.ico`. Cosmetic.

These three branches were left unpushed: they are real work, but opening three more PRs on
brief was not part of this task. They live on `helm/w-4713f07b`, `helm/w-ebd7b6cb` and
`helm/w-c1253fff` in `$HELM_HOME/worktrees/Nicegarrry__brief/`.

## Section 5 — an orchestrator drives Helm over MCP

`~/code/web/brief/.mcp.json` (untracked, as `helm.json` is):

```json
{ "mcpServers": { "helm": {
    "command": "node",
    "args": ["/Users/sa/code/other/helm3-local-handoff/helm/bin/helm.js", "serve", "--stdio", "--port", "4747"],
    "env": { "HELM_HOME": "/Users/sa/.helm", "HELM_SPEND_CAP_USD": "5", "HELM_MAX_WORKERS": "3" } } } }
```

A fresh headless Claude Code session (2.1.278) was started in `~/code/web/brief`, restricted to
`--allowedTools mcp__helm` so it had **no** file, edit or shell tools at all, and given one task
in plain English: cover the untested `packages/shared/src/introspection.ts`, then gate, open a
draft PR and request a review.

Tool-call sequence (identical calls collapsed):

```
ToolSearch  (tool discovery)                   x2
mcp__helm__run_status
mcp__helm__worker_list      { repo: … }
mcp__helm__worker_spawn     { repo, model: opencode-go/qwen3.8-flash, role: builder, … }
mcp__helm__worker_inspect   { workerId: w-a841aef8 }          x299
mcp__helm__gate_run
mcp__helm__pr_open
mcp__helm__review_request   { model: google/gemini-3.8-flash }
mcp__helm__pr_status
```

Result: **`https://github.com/Nicegarrry/brief/pull/249`**, draft, head `88e0368`, one file
added — `packages/shared/src/introspection.test.ts` `+393/-0`, 15 tests. Gate passed at that
head (`install` 0, `unit` 0 in 18.5s). Reviewer `w-d4eeefee` spawned on a different family.
The session touched nothing itself; every action went through a Helm tool. The exit proof is met.

### Finding — there is no way to wait, so an orchestrator busy-polls

**299 of the session's 309 turns were `worker_inspect`.** The session reported $16.82 of its own
cost for supervising a worker that cost **$0.052** — 320x the thing it was managing. On a
subscription that is plan usage rather than a bill, so read the number as context and time
burned, not money: 299 round trips of an orchestrator's attention to watch one file get written.

This is the one claim in `README.md` that the live run does not support:

> "…and get back gates, PRs and status **without spending its own context on the mechanics**."

Polling *is* the mechanic, and Helm currently makes the orchestrator pay for it in its own
context. Every tool returns immediately; there is no blocking or long-poll variant, no
`worker.wait`, no completion notification, and `worker.inspect` has no "block until the state
changes" mode. A patient orchestrator therefore spins.

Worth noting the CLI does not have this problem — `helm logs <id> -f` follows, and a human
watches the dashboard. It is specifically the MCP surface, the one the product is *for*, that
lacks a wait.

Suggested shape (not implemented here): a `worker.wait` tool taking a worker id, a set of
states to wait for and a timeout, returning either the reached state or a timeout marker so the
orchestrator can decide whether to keep waiting. One call per state change instead of one call
per two seconds.

### Spend

| | USD |
| --- | --- |
| Helm-tracked worker spend, whole run | 0.367 |
| — `google/gemini-3.8-flash` (reviewers) | ~0.203 + the section-5 reviewer |
| — `opencode-go/qwen3.8-flash` (builders, 8 workers) | ~0.079 |
| — `openrouter/nvidia/nemotron-…:free` (5 workers) | 0.000 |
| Orchestrator's own context, section 5 only (plan usage, not billed) | 16.82 |

The $5 cap applies to the first row and was never approached. The last row is outside Helm's
accounting entirely, which is itself part of the finding above.

---

# v1.1 — 2026-09-21

Two things the v1 run left open: the orchestrator busy-polled because there was nothing to
wait on, and `pr.merge` had never touched real `gh`. Both are closed here, and both turned out
to hide a defect rather than a missing feature.

## `pr.merge` against real `gh`: the first attempt refused a green PR

brief#248 was green on every check, mergeable, and still a draft. Through the v1 daemon:

```
helm merge 248 --head 96d59be…   → { ok: false, reason: "pr is not mergeable" }        (1)
helm merge 248 --head 96d59be…   → { ok: false, reason: "check \"lint · typecheck · test · build\" did not succeed" }   (2)
```

(1) was transient: I had pushed to brief's `main` a minute earlier and GitHub reports
`mergeable: UNKNOWN` while it recomputes, which `mapPrStatus` turned into `null` and the guard
into "not mergeable". Wrong message, right refusal.

(2) was the real bug. The raw rollup for #248 at that moment:

```
{"name":"lint · typecheck · test · build","status":"COMPLETED","conclusion":"SUCCESS"}
{"name":"Vercel","state":"SUCCESS"}
{"name":"Vercel Preview Comments","status":"COMPLETED","conclusion":"SUCCESS"}
```

`gh` reports conclusions in upper case. The guard compared against lower-case `'success'`:

```ts
const failing = status.checks.find((c) => c.conclusion !== null && c.conclusion !== 'success');
```

so every real PR with completed checks was refused. Two other things were wrong in the same
line: a queued check run arrives with `conclusion: ""`, which is neither `null` nor `'success'`
and so was reported as "did not succeed" rather than "still running"; and a commit-status
context such as Vercel has no `conclusion` at all, so it was ignored even when `PENDING`.

**Why the tests passed.** `github.test.ts` fed the transport real casing and asserted it came
back unchanged; `helm.test.ts` fed the service lower-case fakes. Each half was right about its
own side of the seam, and nothing crossed it.

**Fix.** Normalise once, at the boundary, in `github.ts`: lower-case `status` and `conclusion`
for check runs, `conclusion: null` until `status` is `completed`, and commit-status contexts
mapped from their `state` (`SUCCESS` → completed/success, `PENDING`/`EXPECTED` → pending,
anything else → completed/failure). `pr.merge` then refuses in order: not open; a draft
("mark it ready for review first"); mergeability not yet computed ("try again shortly"); a
conflict; a head mismatch; a check that has not finished (naming its status); a check whose
conclusion is not `success`, `neutral` or `skipped` (naming the conclusion). `isDraft` is now
read from `gh` so the draft case is a clear refusal instead of a 405 from the merge API.

**Proven live through the v1.1 daemon**, still on brief#248:

```
helm merge 248 --head 96d59be…   → { ok: false, reason: "pr is a draft; mark it ready for review first" }
gh pr ready 248
helm merge 248 --head 96d59be…   → { ok: true, merged: true }
gh pr view 248 --json state,mergeCommit → MERGED, f35a139a94c3e3fbc209769e67b38382f9421b94
```

That is the first PR Helm has merged. Note `github.ts` merges with `merge_method=squash` via
the REST API pinned to the expected SHA; brief's own history uses merge commits. Worth making
configurable; not changed here.

## `worker.wait`: one call per state change

MCP cannot push. A server has no way to interrupt the model, and Claude Code does not surface
server-initiated notifications as turns. So "ping the orchestrator back" has to mean: the one
call the orchestrator made returns when there is something to act on. `worker.wait` does that —
it blocks until any of the given workers leaves `queued`/`running`, or a timeout passes, and
returns the settled workers with their state, head and result, plus the ids still pending.

The timeout is capped at 25 minutes. Claude Code aborts an MCP tool call that has been silent
for 30 minutes on stdio (5 on HTTP; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); the hard per-call
limit is about 28 hours. Under that idle window a wait is never killed for silence, and a
caller that sees `timedOut: true` simply waits again — that re-call is the failsafe poll, one
every 10–25 minutes instead of one every two seconds. Also `helm wait <id>... [--timeout ms]`
on the CLI, which reads the store directly and needs no daemon.

Inside the daemon the wait re-reads SQLite every 500 ms. That costs the caller nothing: the
orchestrator's context sees one request and one response.

### Before and after, same task shape, same repo, same builder and reviewer

A fresh headless Claude Code session in brief, restricted to `mcp__helm` (no file, edit or
shell tools), asked to get a missing test file written, gated, PR'd and reviewed.

| | v1 (`worker_inspect` only) | v1.1 (`worker_wait`) |
| --- | --- | --- |
| Tool calls to Helm | 307 | 9 |
| …of which polling / waiting | 299 × `worker_inspect` | 3 × `worker_wait` |
| Turns | 309 | 12 |
| Orchestrator context (reported cost) | $16.82 | $0.82 |
| Worker + reviewer spend | $0.052 + reviewer | $0.070 (two builders) + $0.209 reviewer = $0.278 |
| Result | brief#249 | [brief#250](https://github.com/Nicegarrry/brief/pull/250) |

The orchestrator chose `worker_wait` unprompted on its first attempt, with a 15-minute
timeout, and used it again for the reviewer. It also handled a failure without polling: the
first builder burned its turn budget on a bad premise in the ticket (`model.ts` is a pure barrel
of 414 re-exports, not a module with behaviour of its own), `worker_wait` returned it as
`failed`, and the orchestrator re-spawned with the scope cut to the barrel's actual contract.
Nine Helm calls, three of them waits, twelve turns end to end. Tool-call sequence:

```
run_status
worker_spawn                                   → w-bed43fe2
worker_wait   { workerIds: [w-bed43fe2], timeoutMs: 900000 }   → settled: failed
worker_spawn                                   → w-03755e9b (re-scoped from the first worker's findings)
worker_wait   { workerIds: [w-03755e9b], timeoutMs: 1200000 }  → settled: succeeded, head a5ef292
gate_run                                       → passed
pr_open                                        → brief#250
review_request                                 → w-5190af4f (google/gemini-3.8-flash)
worker_wait   { workerIds: [w-5190af4f], timeoutMs: 1200000 }  → settled: succeeded, review.posted
```

`README.md`'s central claim — that the orchestrator gets its results "without spending its own
context on the mechanics" — is now true in the measurement that mattered.

## Counts

`helm/src` 2,817 → 2,915 lines (ceiling 3,000). Tests 99 → 107; the three that pin the merge
guard and the normalisation were each run against v1 and fail there.

---

# v1.2 — 2026-09-21

## The orphan and the one-project limit were one flaw

After the v1.1 proof, the `serve --stdio` process that Claude Code had started was still
running after Claude Code exited, and `serve.json` still pointed at it. Separately, the owner
asked whether only one project at a time could use Helm on a machine — and the answer was yes:
`serve` refused to start beside a live `serve.json`, so a second project's session got no tools.

Both came from the same shape: the MCP front-end and the daemon were one process. v1.2 splits
them. `serve --http` is the daemon — store, workers, dashboard, CLI endpoint, HTTP MCP. `serve
--stdio` is a front-end for one session: it attaches to the running daemon, or starts one
detached (logging to `$HELM_HOME/daemon.log`) and then attaches, forwards every tool call, and
exits on stdin EOF — which is what its client closing looks like. The daemon outlives sessions
on purpose; `helm shutdown` stops it. Tool calls are forwarded over `node:http`, not `fetch`,
because undici abandons a response after five silent minutes and `worker.wait` may hold one
open for twenty-five.

Line budget: 2,915 → 2,980 of 3,000.

### Test, run against v1.1 first

`mcp-stdio.test.ts` now has two tests. Both fail on v1.1's `cli.ts`/`server.ts` (swapped in
from the tag) and pass on v1.2:

- the original client test, plus an assertion that the daemon's pid is not the front-end's;
- two front-ends on one `HELM_HOME`: the second attaches instead of starting a daemon, both
  answer `run.status`; closing the first client makes its front-end exit within 5 s while the
  daemon and the second client carry on.

### Live: two projects at once

Two headless Claude Code sessions, one in `~/code/web/brief` and one in `~/code/VG`, started two
seconds apart, each restricted to `mcp__helm`, each asked for one `run_status`:

```
while both ran:   serve.json {"port":4747,"pid":27711}   front-ends: 2   daemons: 1
brief  → spendUsd 0.752095391, spendCapUsd 5, activeWorkers 0   (3 turns)
vg     → spendUsd 0.752095391, spendCapUsd 5, activeWorkers 0   (3 turns)
after both exited:                                     front-ends: 0   daemon: still up
helm shutdown → sent SIGINT to helm serve (pid 27711)
```

Same store, same cap, same numbers from both repos; nothing left behind when they closed.

## `pr.merge`, twice more

brief#249 and #250 (the v1 and v1.1 MCP proofs' PRs) were merged through Helm on the v1.1
daemon: `gh pr ready`, then `helm merge <n> --head <sha>`. #249 merged first try
(`273db94`); #250 was refused once with "github has not finished computing mergeability; try
again shortly" — #249 had just landed on its base — and merged on the retry (`627bb1d`). That
is the guard added in v1.1 doing precisely what it was added for.

## v1.3 — the Codex lane (2026-09-21)

Workers named `codex/<model>[:<effort>]` run the Codex CLI on the operator's ChatGPT
subscription instead of a Pi session. Proven against `codex-cli 0.153.4` (`codex login
status` → "Logged in using ChatGPT") on the same Mac as the earlier sections.

### Probes that shaped the runner (each executed, not quoted)

- `codex exec --json … -o last.md -` on a scratch repo: events are `thread.started`
  ({thread_id}), `turn.started`, `item.started`/`item.completed` with item types
  `command_execution` ({command, aggregated_output, exit_code, status}), `file_change`
  ({changes:[{path,kind}]}), `agent_message` ({text}), `error` ({message}), and
  `turn.completed` ({usage:{input_tokens, cached_input_tokens, cache_write_input_tokens,
  output_tokens, reasoning_output_tokens}}). The `-o` file holds the final message.
- `codex exec resume <thread_id>` keeps the earlier context ("PROBE OK" → "PROBE OK AGAIN")
  but **resumed on the config default model** (`gpt-6-astra`) when `-m` was omitted — so the
  runner always passes `-m`. `resume` accepts `-m`, `-c`, `--json`, `-o`,
  `--skip-git-repo-check` and not `-C`/`-s`; the sandbox rides `-c sandbox_mode=…`.
- `-s workspace-write -c approval_policy="never"`: the model wrote `hello.txt`, then
  `git commit` failed with `.git/index.lock: Operation not permitted` — Codex's sandbox
  refuses writes under `.git/`. Helm therefore commits for the worker, as it already did.
  Network is off in that sandbox by default, so a push cannot reach GitHub either way.

### Live run through the daemon on this branch (`HELM_HOME` scratch, port 4750, cap $1)

Scratch repo with a `helm.json` gate of `test -f hello.txt`.

| Step | Result |
| --- | --- |
| `helm spawn --model codex/gpt-5.6-luna:low` | `w-3d8331ff`, branch `helm/w-3d8331ff` |
| `helm wait` | `succeeded` after 29,619 ms; Helm committed head `026bad6` (`hello.txt | 1 +`) |
| events | `turn.start` → `notice` (Codex's own hooks warning) → `tool.call` bash ×2 + edit ×1 → `turn.end` {exitCode 0} → `result` |
| `helm gate` | passed, `hello-exists` exit 0 at `026bad6` |
| `helm steer "Also create bye.txt…"` | turn 3 ran as `codex exec resume <thread>`; `succeeded`, head `4eff057`, worktree holds both files with the exact lines |
| `helm status` | `spendUsd: 0`, `unknownCostEvents: 0` — subscription usage is metered as tokens, never as spend |
| tokens recorded for the worker | `{"input":22608,"output":1319,"cacheRead":208640,"cacheWrite":0}` |
| `helm shutdown` | daemon exited cleanly |

Suite: 117 tests, 117 pass (108 before; nine new in `test/codex.test.ts` against a fake
`codex` binary that replays the probed event shapes). `tsc --noEmit` clean. `helm/src` is
3,069 lines after cutting the duplicated event summariser and the daemon-less `wait`.
