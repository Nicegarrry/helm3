# Helm

A small harness that lets an orchestrator agent (Claude Code, Codex, or a script) dispatch
coding work to workers, each in its own git worktree, and get back gates, PRs and status
without spending its own context on the mechanics. Three lanes serve the workers: Pi sessions
on cheap API models, the Codex CLI on the operator's ChatGPT subscription, and the Claude CLI
on the operator's Claude subscription (both at $0 marginal cost).

Sixteen tools, one SQLite file, one daemon shared by every project on the machine. Under 3.1k
lines of TypeScript.

## Five-minute start

1. Install Node 22 and Pi, then log in to the providers you want workers to use:

   ```sh
   npm install            # from helm/ (or symlink ../node_modules if you use the monorepo root)
   pi login               # writes ~/.pi/agent/auth.json; Helm reads it, never copies it
   codex login status     # the Codex lane needs the Codex CLI signed in to ChatGPT
   gh auth status         # gh is used for pr.open, pr.status, review comments and merge
   ```

2. Give the tools to an orchestrator. For Claude Code, add to the project's `.mcp.json`:

   ```json
   { "mcpServers": { "helm": { "command": "/path/to/helm/bin/helm.js", "args": ["serve", "--stdio", "--port", "4747"],
                             "env": { "HELM_SPEND_CAP_USD": "5" } } } }
   ```

   That is all the setup there is. `serve --stdio` is a front-end for one session: it attaches
   to the daemon if one is running, otherwise starts one in the background first, and exits
   when its client does. The daemon (`helm serve --http`) owns the store and the workers,
   keeps running between sessions, and is shared by every project that points at the same
   `$HELM_HOME` (default `~/.helm`) — so two Claude Code sessions in two repos see one store,
   one cap. Its environment is whichever session started it; to give a project its own daemon
   and cap, give it its own `HELM_HOME` in `env`.

   For Codex or anything that speaks Streamable HTTP, point it at `http://127.0.0.1:<port>/mcp`
   (the port is in `$HELM_HOME/serve.json`; start the daemon by hand with
   `HELM_SPEND_CAP_USD=5 ./bin/helm.js serve --http --port 4747` if nothing has yet).

3. Safely stop an idle daemon with `helm shutdown`. If busy, it closes admissions and
   reports blockers; let them finish, then repeat the command. See safe updates below.

## Deploys

Reviewed base-branch deploys without a Vercel token or Convex deploy key use whichever Vercel/Convex account the operator is logged into and deploy to that project's production. Vercel production deploys still require org and project IDs from target configuration or the resolved checkout's `.vercel/project.json`; Convex uses `CONVEX_DEPLOYMENT` from the resolved checkout's `.env.local`. Branch-preview deploys keep a temporary `HOME` and require their scoped credentials. Installs and smoke commands always keep a temporary `HOME`, while TestFlight remains base-branch-only and uses the real `HOME`.

4. Run one task by hand to see the loop:

   ```sh
   helm spawn --repo /path/to/target --objective "Add a --version flag"
   helm ps
   helm logs w-1a2b3c4d -f
   helm gate w-1a2b3c4d
   helm pr w-1a2b3c4d
   helm review w-1a2b3c4d
   helm status
   ```

## Tools

| Tool | What it does |
| --- | --- |
| `worker.spawn` | Create a worktree on a new branch and start a worker on it. `repo` is a local path or `owner/name` (cloned once under `$HELM_HOME/repos`). `model` is optional; `difficulty` selects the default (see below). An explicit model picks the lane: `provider/model` as Pi names it, `codex/<model>[:<effort>]` for the Codex CLI (`codex/gpt-6-astra:medium`), or `claude/<model>[:<effort>]` for the Claude CLI (`claude/sonnet:high`). |
| `worker.inspect` | State, head, spend, diff stat, result and recent events for one worker. |
| `worker.list` | One line per worker. |
| `worker.wait` | Block until any of the given workers settles (leaves `queued`/`running`) or a timeout passes. One call per state change instead of polling `worker.inspect`; on `timedOut`, call it again. |
| `worker.steer` | Send a follow-up message to an idle or interrupted worker in its own session (a Pi session, or a Codex thread resumed with the same model). |
| `worker.stop` | Ask a running worker to stop. |
| `gate.run` | Run the repo's checks in the worktree at its exact head and record the result. |
| `pr.open` | Push the branch and open a PR. Refused unless a gate passed at the current head. |
| `pr.status` | Mergeability, checks and reviews from GitHub. |
| `review.request` | Spawn a read-only reviewer on the PR head; posts the verdict as a PR comment. Refused if the reviewer is the builder's model or the same model family (`allowSameFamily` overrides). |
| `review.record` | Record an external review comment and its exact-head merge verdict. |
| `run.status` | Spend, cap, per-project budgets, active workers and daemon lifecycle. |
| `budget.open` / `budget.close` / `budget.status` | Open, close and inspect per-project sprint budgets. A new budget closes the previous one; worker spend remains attributed to the budget active at spawn. |
| `daemon.control` | Inspect lifecycle, drain new work, resume admissions, safely shut down, or apply a staged upgrade when idle. |
| `pr.merge` | Merge only when the PR is open, not a draft, mergeable, every check has finished and succeeded, and the head matches. |

Every tool returns `{ ok: true, ... }` or `{ ok: false, reason }`. Nothing throws across the
boundary.

## Model selection

Omit `model` to use the following policy on both CLI and MCP:

| Task tier | Model | Runtime |
| --- | --- | --- |
| Normal (default) | `codex/gpt-5.6-terra:medium` | Codex CLI, ChatGPT subscription |
| Easy | `codex/gpt-5.6-luna:medium` | Codex CLI, ChatGPT subscription |
| Super easy | `opencode-go/qwen3.8-flash` | Pi |
| Review of any of these | `google/gemini-3.8-flash` | Pi |

Use `helm spawn --repo /path/to/repo --objective "…" --difficulty easy` or pass
`difficulty: "easy"` to `worker.spawn`. The caller classifies the task; Helm does not
infer difficulty from the objective. `super-easy` is for small, mechanical work.
An explicit `--model` (MCP `model`) overrides the tier. Kimi K3 and Qwen 3.8 Max are
never selected automatically, including on failures; explicit overrides remain available.

`helm review <id>` / `review.request` also accepts an omitted model. Reviews default to
Gemini Flash; if an explicitly selected builder is Gemini, the default reviewer is Codex
Terra to retain family independence. A direct `worker.spawn` with `role: "reviewer"`
defaults to Gemini Flash. Resume/steer keeps the worker's originally selected model.

The Codex CLI must be signed in with ChatGPT (`codex login status`). Subscription usage
is still finite; this policy does not measure remaining quota or automatically switch to
paid APIs when Codex is unavailable. Pi routes need the corresponding provider login.
See the Codex reviewer sandbox limitation below when reviewing a Gemini build.

### The Claude lane

A `claude/…` model runs `claude -p` in the worker worktree. The binary is
`$HELM_CLAUDE_BIN`, else `~/.local/bin/claude`, else `claude` on PATH. Model strings accept
`claude/<model>[:<effort>]`, for example `claude/sonnet:high`, `claude/opus:medium` and
`claude/fable:high`; the suffix becomes Claude's `--effort` flag. Claude uses
`--output-format stream-json --verbose`, records its session id as `claude-session:<id>`, and
resumes steer/retry turns with `--resume <id>`. Builders receive `acceptEdits` plus explicit
worktree tool permissions; reviewers use `plan` with read-only tools. Web search/fetch,
`gh`, pushes, worktree changes and common outside-worktree shell escapes are disallowed, and
only the worker worktree is added with `--add-dir`. The child receives a minimal environment,
not Helm configuration, provider keys or webhooks. Claude subscription usage is recorded with
`costUsd: 0`.

## What a worker can and cannot do

Workers get Pi's built-in tools: read, bash, edit, write, grep, find, ls. A `tool_call` hook
refuses paths outside the worktree (symlinks are resolved), writes under `.git/`, writes under
`.github/workflows/` unless the spawn allowed it, and shell commands that push, call `gh`,
touch worktrees, check out other refs, or `rm -rf /`. Git commands are tokenised, so
inserting flags such as `git -C .. push` does not get past the check. Reviewers additionally
cannot write. Refusals are logged as events and shown to the model as the tool result.

This is a cooperative deny list, not an OS sandbox. A worker's shell can still read files
outside the worktree. Run the daemon under whatever OS-level isolation you need.

A worker's final message must be one JSON object: `status`, `summary`, `changedFiles`,
`commandsRun`, optional `notes`. One correction turn is allowed; after that the worker is
marked failed and the raw text is saved.

Gates come from `<repo>/helm.json` (`{ "gates": [{ "name", "command" }] }`) or default to
the `test`, `typecheck` and `lint` scripts in `package.json`.

### The Codex lane

A `codex/…` model runs `codex exec` (non-interactive) in the worktree instead of a Pi
session, on whatever account `codex login` holds. Codex's own sandbox is the policy on this
lane, not the deny list above: builders run `workspace-write` (files inside the worktree
only; Codex refuses writes under `.git/`, so a Codex worker cannot commit, and Helm commits
its changes after the turn exactly as it does for Pi workers), reviewers run `read-only`.
Network is off inside the sandbox unless the daemon has `HELM_CODEX_NETWORK=1`, so a worker
cannot push or call GitHub either way; `pnpm install --prefer-offline` and friends work from
the local store.

The `:effort` suffix sets `model_reasoning_effort` (`low`, `medium`, `high`, `xhigh`);
without it Codex uses its config default. A turn's session is the Codex thread id, recorded
as `sessionFile` (`codex-thread:<uuid>`), so `worker.steer` and resume-after-restart go
through `codex exec resume <id>` with the same model. Usage is recorded from Codex's
`turn.completed` event with `costUsd: 0`: subscription tokens count as tokens, never as
spend, and never as unknown-cost events. Codex's stdout events map onto the same
`tool.call` / `turn.start` / `turn.end` / `result` kinds; its own warnings arrive as `notice`.
The binary is `$HELM_CODEX_BIN`, else `~/.local/bin/codex`, else `codex` on PATH.

A non-zero exit is never a healthy turn: the worker lands in `unknown` with the stderr tail as
its error, its worktree keeps whatever was written, and a steer resumes it. A stop request is
honoured on the next event or within half a second, whichever comes first, so a worker deep in
one long silent command is still killed inside `worker.stop`'s wait. One limit measured live:
a **Codex reviewer's** `read-only` sandbox refuses the IPC socket `tsx` binds to run tests, so a
Codex reviewer can typecheck and read but not run a `tsx`-based suite — put run-the-code
reviews on the Pi lane, or rely on the gate.

## Safe updates (v1.5 and later)

Keep the running daemon on its existing release while you prepare an update:

```sh
helm update --stage <commit-or-tag> --repo /path/to/helm3
helm update --when-idle --timeout 600000
helm daemon --action status --json
```

Staging archives the exact commit into a separate directory under `$HELM_HOME/releases`,
installs frozen dependencies, and runs typecheck/tests with a separate test home. It selects
that artifact only after validation succeeds. It never restarts or drains the daemon.
`--when-idle` is the separate activation step: it launches a detached helper from the
running daemon so the new release inherits its provider environment and spend settings.
No credentials are written into release metadata or the upgrade journal.

During drain, CLI and MCP refuse new builds, follow-up turns, reviews, gates and PR writes.
Already admitted work finishes, including commits and review callbacks. Status, logs and
explicit worker stops remain available. Orchestrators should pause dispatch when they see
`draining` and retry refused work after admissions reopen; no mutation is replayed for them.

When all work settles, the helper stops the old daemon and starts the validated release on
the **same port and state directory**, with admissions still closed. It checks the new
process, version and revision before reopening admissions. Existing stdio proxies retain
that port; a request during the brief handover can fail and must be inspected before retry.
Future automatic starts select the installed release recorded in `current-release.json`.

A timeout leaves the old daemon running and draining, with blockers in `upgrade.json`. After
the helper finishes, cancel the drain with `helm daemon --action resume`,
or retry activation. A failed startup leaves admissions closed; inspect `upgrade.log` and
`daemon.log` before starting a known-good release manually. There is no automatic database
rollback. A release changed after validation is refused before shutdown.

Manual controls are `helm daemon --action drain`, `status` and `resume`. `helm shutdown`
refuses to exit with active work. SIGINT/SIGTERM drain for up to ten minutes and leave the
daemon running on timeout; another signal does not force-kill workers.

`run.status` shows the running version, staged version, phase and blockers.
`daemon.lock` is acquired before opening SQLite. A stale lock is deliberately **not** stolen:
after a crash, verify the recorded owner and any surviving worker/gate processes have stopped
before removing that lock directory. Likewise, only remove a stale `upgrade.lock` after its
helper is confirmed stopped and the journal/daemon state has been inspected. Keep `drain.json`
until recovery is complete, then use `resume`. Normal shutdown releases ownership itself.

**First installation:** v1.4 and older do not implement drain. Let their current work finish,
pause dispatch across clients, and install v1.5 during a quiet window. Update client launch
paths too. The new updater refuses legacy daemons; it never sends them a shutdown signal.
Merging a PR alone does not install or activate an update.

## Waiting, not polling

An orchestrator should never loop on `worker.inspect`. After `worker.spawn` (or
`review.request`) call `worker.wait` with the worker id and go quiet: it returns when the
worker leaves `queued`/`running` — succeeded, failed, idle, stopped or interrupted — carrying
the state, head and result, or after `timeoutMs` with `timedOut: true`, in which case call it
again. Pass several ids to wake on the first that settles; the rest come back as `pending`.
The timeout is capped at 25 minutes so a wait always returns inside Claude Code's 30-minute
idle window for stdio MCP servers (5 minutes on HTTP — use a shorter timeout there, or raise
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). Measured live, this took one orchestrator from 299
polling calls to a handful of waits for the same job; `helm/evidence/live.md` has the numbers.

## Watching it

`helm ps`, `helm logs <id> -f`, `helm inspect <id>` and `helm status` read the store directly
and work without the daemon.

The daemon's loopback HTTP interface is reserved for the CLI, health checks, tool calls, and
MCP; use Discord or chat for live coordination.

## Durability and cost

Everything is in `$HELM_HOME/helm.sqlite`: workers, events, gates, prs, spend, budgets and
worker-to-budget attribution. Worktrees
are under `$HELM_HOME/worktrees/`, captured gate output under `$HELM_HOME/logs/`, Pi session
files under `$HELM_HOME/sessions/`. If the daemon dies, running workers become
`interrupted` on the next start and `worker.steer` resumes their Pi session. Nothing is
replayed automatically.

Spend is summed from Pi usage events times the model's catalogue price. Per-project sprint budgets
are created automatically at the configured default when a project first spawns a worker;
`budget.open` starts a new sprint and closes the old one. `HELM_SPEND_CAP_USD` is only a lifetime
global backstop: it refuses new spawns and stops running workers at the next tool call once reached.
A value of `0` or an unset variable means no global cap. A soft cap,
`HELM_SPEND_WARN_USD` (default 80% of the hard cap), never blocks: crossing it records a
`spend.warning` event, sets `aboveSoftCap` in `run.status`, adds a `warning` field to spawn
and steer results so the orchestrator sees it. Models
with no price are counted as tokens and reported as unknown-cost events, never blocked.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELM_HOME` | `~/.helm` | State directory |
| `HELM_SPEND_CAP_USD` | `0` (no cap) | Run-wide hard spend cap |
| `HELM_SPEND_WARN_USD` | 80% of the cap | Soft cap: warn, never block |
| `HELM_MAX_WORKERS` | `3` | Concurrent workers |
| `HELM_GATE_TIMEOUT_MS` | `900000` | Per-check timeout |
| `HELM_CODEX_BIN` | `~/.local/bin/codex`, else `codex` | The Codex CLI the `codex/…` lane runs |
| `HELM_CODEX_NETWORK` | unset | `1` lets Codex builders reach the network inside their sandbox |
| `HELM_CLAUDE_BIN` | `~/.local/bin/claude`, else `claude` | The Claude CLI the `claude/…` lane runs |

## Development

```sh
npm run typecheck
npm test
```

Tests run against Pi's packaged faux provider and a fake `gh`; no network, no credentials.
`test/e2e.test.ts` drives the real composition (SQLite, git worktree, gate runner, Pi
session, HTTP daemon) end to end.

## Private mobile monitoring (v1.7)

Publish `helm/dashboard/` to a PIN-protected here.now site, then run
`helm fleet sync --site YOUR_PRIVATE_SLUG` alongside your existing daemon.
Use repeatable `--source label=/absolute/helm-home` flags for multiple fleets.
The phone view refreshes every 30 seconds and shows stale or unavailable sources
without exposing prompts, logs or build controls. This companion does not require
a daemon restart. See [mobile fleet setup](docs/mobile-fleet.md) for access checks,
credentials, source selection, and stopping the publisher. The hosted mobile monitor uses local
font files only and has an accessible, persisted System / Light / Dark appearance selector;
System follows the device setting and storage failures safely fall back to it.
