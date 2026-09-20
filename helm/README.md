# Helm

A small harness that lets an orchestrator agent (Claude Code, Codex, or a script) dispatch
coding work to Pi workers running cheap models, each in its own git worktree, and get back
gates, PRs and status without spending its own context on the mechanics.

Twelve tools, one SQLite file, one daemon shared by every project on the machine. Under 3k
lines of TypeScript.

## Five-minute start

1. Install Node 22 and Pi, then log in to the providers you want workers to use:

   ```sh
   npm install            # from helm/ (or symlink ../node_modules if you use the monorepo root)
   pi login               # writes ~/.pi/agent/auth.json; Helm reads it, never copies it
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
   one cap and one dashboard. Its environment is whichever session started it; to give a
   project its own daemon, cap and dashboard, give it its own `HELM_HOME` in `env`.

   For Codex or anything that speaks Streamable HTTP, point it at `http://127.0.0.1:<port>/mcp`
   (the port is in `$HELM_HOME/serve.json`; start the daemon by hand with
   `HELM_SPEND_CAP_USD=5 ./bin/helm.js serve --http --port 4747` if nothing has yet).

3. Stop the daemon when you want workers and the dashboard gone: `helm shutdown`.

4. Run one task by hand to see the loop:

   ```sh
   helm spawn --repo /path/to/target --objective "Add a --version flag" --model opencode-go/qwen3.8-flash
   helm ps
   helm logs w-1a2b3c4d -f
   helm gate w-1a2b3c4d
   helm pr w-1a2b3c4d
   helm review w-1a2b3c4d --model google/gemini-3.8-flash
   helm status
   ```

## Tools

| Tool | What it does |
| --- | --- |
| `worker.spawn` | Create a worktree on a new branch and start a Pi worker on it. `repo` is a local path or `owner/name` (cloned once under `$HELM_HOME/repos`). |
| `worker.inspect` | State, head, spend, diff stat, result and recent events for one worker. |
| `worker.list` | One line per worker. |
| `worker.wait` | Block until any of the given workers settles (leaves `queued`/`running`) or a timeout passes. One call per state change instead of polling `worker.inspect`; on `timedOut`, call it again. |
| `worker.steer` | Send a follow-up message to an idle or interrupted worker in the same Pi session. |
| `worker.stop` | Ask a running worker to stop. |
| `gate.run` | Run the repo's checks in the worktree at its exact head and record the result. |
| `pr.open` | Push the branch and open a PR. Refused unless a gate passed at the current head. |
| `pr.status` | Mergeability, checks and reviews from GitHub. |
| `review.request` | Spawn a read-only reviewer on the PR head; posts the verdict as a PR comment. Refused if the reviewer is the builder's model or the same model family (`allowSameFamily` overrides). |
| `run.status` | Spend, cap, active workers. |
| `pr.merge` | Merge only when the PR is open, not a draft, mergeable, every check has finished and succeeded, and the head matches. |

Every tool returns `{ ok: true, ... }` or `{ ok: false, reason }`. Nothing throws across the
boundary.

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

The daemon serves a read-only dashboard on loopback (the port is in `$HELM_HOME/serve.json`;
each stdio front-end prints the URL to stderr when it attaches).
Open `http://127.0.0.1:<port>/` in a browser:

- Live workers: state, role, model, spend, tokens, elapsed (ticking), head, objective and
  last event, with all / active / done / failed filters and a text filter.
- Click a worker for its detail drawer: result and notes, gates with per-check exit codes,
  PR link, diff stat, and its event history. `#w-<id>` in the URL deep-links to it.
- Per-model rollup of workers, spend and tokens, and a cumulative spend timeline against the cap.
- A live event stream across all workers, refusals and errors in red.

It polls every two seconds, pauses when the tab is hidden, and is plain HTML with inline
vanilla JavaScript: no framework, no build step, no external resources. It follows the system
light or dark appearance; append `?theme=dark` or `?theme=light` to force one. The same data is
available as JSON at `GET /api/state`, `GET /api/worker/<id>` and `GET /api/events?after=<seq>`;
`curl` on `/` returns the plain `helm ps` table.

## Durability and cost

Everything is in `$HELM_HOME/helm.sqlite`: workers, events, gates, prs, spend. Worktrees
are under `$HELM_HOME/worktrees/`, captured gate output under `$HELM_HOME/logs/`, Pi session
files under `$HELM_HOME/sessions/`. If the daemon dies, running workers become
`interrupted` on the next start and `worker.steer` resumes their Pi session. Nothing is
replayed automatically.

Spend is summed from Pi usage events times the model's catalogue price. `HELM_SPEND_CAP_USD`
refuses new spawns and stops running workers at the next tool call once reached. A soft cap,
`HELM_SPEND_WARN_USD` (default 80% of the hard cap), never blocks: crossing it records a
`spend.warning` event, sets `aboveSoftCap` in `run.status`, adds a `warning` field to spawn
and steer results so the orchestrator sees it, and turns the dashboard bar amber. Models
with no price are counted as tokens and reported as unknown-cost events, never blocked.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELM_HOME` | `~/.helm` | State directory |
| `HELM_SPEND_CAP_USD` | `0` (no cap) | Run-wide hard spend cap |
| `HELM_SPEND_WARN_USD` | 80% of the cap | Soft cap: warn, never block |
| `HELM_MAX_WORKERS` | `3` | Concurrent workers |
| `HELM_GATE_TIMEOUT_MS` | `900000` | Per-check timeout |

## Development

```sh
npm run typecheck
npm test
```

Tests run against Pi's packaged faux provider and a fake `gh`; no network, no credentials.
`test/e2e.test.ts` drives the real composition (SQLite, git worktree, gate runner, Pi
session, HTTP daemon) end to end.
