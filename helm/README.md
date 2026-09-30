# Helm

A small harness that lets an orchestrator agent (Claude Code, Codex, or a script) dispatch
coding work to workers, each in its own git worktree, and get back gates, PRs and status
without spending its own context on the mechanics. Three lanes serve the workers: Pi sessions
on cheap API models, the Codex CLI on the operator's ChatGPT subscription, and the Claude CLI
on the operator's Claude subscription (both at $0 marginal cost).

Forty-five operational tools plus two meta tools, one SQLite file, and one daemon shared by
every project on the machine. MCP uses small tool profiles so an orchestrator does not pay for
the full harness catalog on every session.

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
   { "mcpServers": { "helm": { "command": "/path/to/helm/bin/helm.js", "args": ["serve", "--stdio", "--port", "4747", "--tools", "core"],
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
   with `Authorization: Bearer <token>` on every request. The daemon generates a new
   random token at startup and stores it with port/pid in `$HELM_HOME/serve.json`, created
   with mode `0600`. CLI, stdio, upgrade and fleet clients read it at each call; keep this
   file private and never copy the token into worker environments or logs.
   An HTTP MCP client such as Codex must read `port` and `token` from `serve.json` at
   connect time and use the token in that header; re-read it whenever reconnecting after
   a restart. A fixed token in client configuration becomes stale on restart. Prefer
   `helm serve --stdio` when the client supports stdio: its proxy re-reads the token on
   every call, so no token needs to be copied into the client's configuration.
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

## MCP tool profiles

`serve --stdio` and the `/mcp` endpoint default to the `core` profile. Select `core`,
`supervisor`, or `all` with `--tools <profile>` or `HELM_TOOLS`. The CLI and loopback HTTP
`/tools/<name>` calls retain access to every registered tool regardless of the MCP profile.

`core` exposes `worker.spawn`, `worker.steer`, `worker.inspect`, `inbox.reply`, `wake.list`,
`gate.run`, `pr.open`, `run.status`, `helm.call`, and `helm.help`. Everything else is still
available through `helm.call`. `supervisor` adds the next most-used review, claims, baseline, PR,
envelope, deploy, memory, scorecard, budget, and spend tools; `all` exposes the complete catalog.
`helm.help` with no argument returns one compact line per tool; pass `{ "tool": "worker.spawn" }`
for that tool's full JSON schema and description. `helm.call` accepts `{ "tool": "...", "input":
{ ... } }` and runs the named tool through the same validation, lifecycle guards, and tap rules as
a direct call.

MCP responses are compact by default. `worker.list` (available through `helm.call`) returns active,
waiting, queued, and recently settled workers as short lines, while `worker.inspect` returns five
bounded events. `wake.list` returns readable lines and gate, PR, and status results omit large nested
blobs. Pass `verbose: true` in the target input to opt into the full response.

## Tools

| Tool | What it does |
| --- | --- |
| `worker.spawn` | Create a worktree on a new branch and start a worker on it. `repo` is a local path or `owner/name` (cloned once under `$HELM_HOME/repos`). `model` is optional; `difficulty` selects the default (see below). An explicit model picks the lane: `provider/model` as Pi names it, `codex/<model>[:<effort>]` for the Codex CLI (`codex/gpt-6-astra:medium`), or `claude/<model>[:<effort>]` for the Claude CLI (`claude/sonnet:high`). |
| `worker.inspect` | State, head, spend, diff stat, result and recent events for one worker. |
| `worker.list` | Compact active/recent worker lines; call through `helm.call` in core. |
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
| `helm.call` | Call any registered tool by name through normal validation and guards. |
| `helm.help` | List the tool catalog or inspect one tool's full schema and description. |

Every tool returns `{ ok: true, ... }` or `{ ok: false, reason }`. Nothing throws across the
boundary.

## Model routing

When `model` and `difficulty` are omitted, Jev scores the ticket from 0 through 4 and
maps the expected value to tier 1 through 5. Helm checks each tier's candidates in order,
skipping models that are not allowed, unavailable, or below the scorecard clean-rate
threshold. A higher tier is tried when the current tier has no usable candidate.

| Tier | Ordered candidates (cheapest first) |
| --- | --- |
| 1 | `openrouter/qwen/qwen3.8-flash`, `openrouter/deepseek/deepseek-v4.1-flash`, `codex/gpt-6-luna:medium`, `codex/gpt-5.6-luna:medium` |
| 2 | `google/gemini-3.8-flash`, `codex/gpt-6-luna:high`, `codex/gpt-5.6-luna:high` |
| 3 | `claude/sonnet:high`, `codex/gpt-5.6-terra:high` |
| 4 | `codex/gpt-6.1-sol:medium`, `codex/gpt-5.6-sol:medium`, `claude/opus:medium` |
| 5 | `codex/gpt-6-astra:high`, `claude/opus:high`, `claude/fable:high`, `codex/gpt-6.1-sol:high`, `codex/gpt-5.6-sol:high` |

The tier-1 Qwen entry is the requested `openrouter/qwen/qwen3.8-flash` identifier. The
current operator `models.json` exposes the older `opencode-go/qwen3.8-flash` override
instead, so the catalog reports this requested candidate unavailable until configured;
it does not silently substitute it. Gemini 3.8 Flash is present in Pi's Google catalog.
`claude/*` candidates remain unavailable
until Helm has a Claude worker lane. The table, `allowed`, `minClean`, `minN`, `policy`,
and `checkDays` are hot-reloaded from `$HELM_HOME/helm.json` for each automatic route.
`routing.policy.lanes` may contain `codex`, `pi`, and `claude`; `subscriptionOnly: true`
permits only Codex and Claude. `worker.spawn` accepts a repeatable `lanes` override for
one spawn. Jev still scores every spawn without an explicit model before policy filtering.
If a policy empties the judged tier, Helm searches higher tiers, then lower tiers; if all
candidates are disallowed or unavailable it refuses with the policy reason rather than
silently choosing one.

`helm routing check` (or the `routing.check` tool) probes the catalog and records the last
check in the Helm store. The weekly ticker runs it when `checkDays` has elapsed and emits
`routing.stale` for unavailable tier candidates or models present in a lane but absent from
the table. The Codex probe runs `codex debug models`; Pi reads its
operator and built-in provider catalogs; Claude requires both a binary and a registered
Helm lane.

Retrospectives should review the 30-day model × tier scorecard, then edit the ordered
`routing.tiers` lists or `routing.allowed` in `helm.json`. Keep the cheapest acceptable
candidate first, and use a later candidate or higher tier when the clean rate is below
`minClean` with at least `minN` observations. An explicit `model` bypasses routing;
`difficulty` maps directly to tiers 1, 2, and 3 and still uses policy and availability checks.

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
resumes steer/retry turns with `--resume <id>`. Both roles use `--restricted`, `--safe-mode`,
an empty strict MCP configuration and no permission prompts. Builders receive `acceptEdits`
plus `Read,Edit,Write,Glob,Grep,Bash`; reviewers use `plan` with `Read,Glob,Grep,Bash`, but
their sandbox has no worktree write access. The Claude OS sandbox fails closed, permits builder
writes only in the worker worktree and a per-worker temp directory cleaned with the worktree,
denies common credential locations (while re-allowing the assigned worktree), and denies network access. Web search/fetch,
`gh`, pushes, worktree changes and common outside-worktree shell escapes remain defense-in-depth
denials, and only the worker worktree is added with `--add-dir`. The child receives a minimal
environment, not Helm configuration, provider keys or webhooks. Claude subscription usage is
recorded with `costUsd: 0`.

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
Helm explicitly passes `sandbox_workspace_write.network_access=false` to builders unless
its daemon has `HELM_CODEX_NETWORK=1`. Codex's native network restriction blocks TCP,
including loopback daemon calls; local Unix sockets are a separate sandbox allowance.
With `HELM_CODEX_NETWORK=1`, builders get network access, including loopback: Helm does
not add a daemon-port firewall rule to that lane. Reviewers retain `read-only` and never
receive Helm's network opt-in. Offline installs work from the local store.

The Codex worker sandbox permits filesystem reads outside the worktree, including
`$HELM_HOME/serve.json`; mode `0600` does not hide it from a worker running as the same
user. The token is not passed in worker environments, but it is not unreadable by workers.
A network-enabled Codex worker that reads it can authenticate to the daemon. Follow-up:
migrate the Codex lane to a permission profile that denies this file and its temporary
siblings, and prove the denial for fresh and resumed workers. Codex's
[permission profiles](https://learn.chatgpt.com/docs/permissions) support read denials but
cannot be combined with Helm's current `sandbox_mode` / `sandbox_workspace_write`
settings; adding a deny key to those settings would not establish protection.

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

**One-time bearer-token migration (this version):** wait for current work to settle, then
stop the pre-auth daemon with its existing CLI (`helm shutdown`) and start this version
with `helm serve --http --port <same-port>` and the same `HELM_HOME` and environment.
Use stop/start for this transition, not `helm update`. The first upgrade's helper runs
from the OLD daemon's `update.mjs`; that pre-auth helper cannot authenticate its new
daemon status checks, so it never sends `resume` and leaves the new daemon draining.
If you already performed that first token-enabled upgrade and the new daemon is healthy,
use this version's CLI to inspect it (`helm daemon --action status --json`) and run
`helm daemon --action resume`. HTTP authentication remains strict during recovery.
Later upgrades between token-enabled versions use a token-aware helper.

Keep the running daemon on its existing release while you prepare subsequent updates:

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
`budget.open` starts a new sprint and closes the old one. `$HELM_HOME/helm.json` is the live global
spend configuration: its optional `spend` object accepts `capUsd`, `warnUsd`, and `maxWorkers`.
Helm re-reads these values when the file changes, so lowering a limit does not require a daemon
restart. The authoritative limits are bootstrapped into the store; direct file edits can only lower
the current effective values, while raises (including removing a cap) are ignored. The environment
variables below are fallbacks only, including values set in a project's `.mcp.json`.
Use `helm cap --usd N [--warn N] [--workers N] [--tap <id>]` to update the file while preserving
other settings. Lowering values is immediate; raising `capUsd` or `maxWorkers` requires a one-time
`spend.cap` tap for the exact requested action. `HELM_SPEND_CAP_USD` is a lifetime global backstop:
it refuses new spawns and stops running workers at the next tool call once reached.
A value of `0` or an unset variable means no global cap. A soft cap,
`HELM_SPEND_WARN_USD` (default 80% of the hard cap), never blocks: crossing it records a
`spend.warning` event, sets `aboveSoftCap` in `run.status`, adds a `warning` field to spawn
and steer results so the orchestrator sees it. Models
with no price are counted as tokens and reported as unknown-cost events, never blocked.

Spend limits are detected-not-prevented against a same-user forge of `helm.sqlite`: a user who can
rewrite the database can also forge the limit state, with the same trust boundary as `envelope.json`.
The daemon's startup Discord line always reports the effective spend limits so such a forge is visible
to Nick.

## Portfolio report

`helm portfolio [--json] [--since <iso>]` reads this daemon's store without requiring a
running daemon. The default window is the last 24 hours. Each project has a compact block
with window USD/Codex tokens, current sprint spend against its budget, merged tickets,
scorecard clean and first-pass gate rates, open PRs awaiting review/merge, workers waiting/running/queued for over two hours,
or idle builders with open PRs and no activity for over two hours, open inbox asks, and taps requested in the window.
The last line totals fleet activity and backlogs. PR review status reflects locally recorded
reviews at the current head; the command does not query GitHub.

For a daily Discord-compatible webhook push, add to the operator `$HELM_HOME/helm.json`:

```json
{ "report": { "at": "06:00", "webhookEnv": "HELM_REPORT_WEBHOOK" } }
```

The ticker uses local machine time and records the successful send date in SQLite, so a
restart retains the daily marker and downtime is caught up on the next tick that day.
If the report env name is missing or its value is empty, it tries the Discord global webhook
env, then the first configured project webhook env. With neither value available, reporting is silently off. Without a
report block, the fallback route uses 06:00. Webhook values come from the daemon environment
or `~/.config/helm/env`. Reports above 2,000 characters are truncated at a line boundary
with a marker and the fleet total retained. Reports run on a separate minute ticker with settings cached for one minute. Failed sends
retry after 5 then 15 minutes, up to three attempts per local day. Attempts and the last
attempt time persist across restarts; exhausting attempts logs once and gives up for that day.

## Configuration

The live spend settings can be placed alongside the other daemon settings in `$HELM_HOME/helm.json`:

```json
{ "spend": { "capUsd": 10, "warnUsd": 8, "maxWorkers": 5 } }
```

`helm.json` wins over environment values; `.mcp.json` environment caps are fallbacks only. Raising a
hard cap or worker limit through `helm cap` needs a granted `spend.cap` tap; the refusal names that
kind so the supervisor can call `tap.request` with the exact action returned by the refusal.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELM_HOME` | `~/.helm` | State directory |
| `HELM_TOOLS` | `core` for MCP | MCP profile: `core`, `supervisor`, or `all` |
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
