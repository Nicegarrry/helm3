# Helm

A small harness that lets an orchestrator agent (Claude Code, Codex, or a script) dispatch
coding work to Pi workers running cheap models, each in its own git worktree, and get back
gates, PRs and status without spending its own context on the mechanics.

Ten tools, one SQLite file, one daemon. About 2.2k lines of TypeScript.

## Five-minute start

1. Install Node 22 and Pi, then log in to the providers you want workers to use:

   ```sh
   npm install            # from helm/ (or symlink ../node_modules if you use the monorepo root)
   pi login               # writes ~/.pi/agent/auth.json; Helm reads it, never copies it
   gh auth status         # gh is used for pr.open, pr.status, review comments and merge
   ```

2. Start the daemon:

   ```sh
   HELM_SPEND_CAP_USD=5 ./bin/helm.js serve --http
   ```

   Workers run inside this process. State lives under `$HELM_HOME` (default `~/.helm`).

3. Give the tools to an orchestrator. For Claude Code, add to `.mcp.json`:

   ```json
   { "mcpServers": { "helm": { "command": "/path/to/helm/bin/helm.js", "args": ["serve", "--stdio"] } } }
   ```

   For Codex or anything that speaks Streamable HTTP, point it at `http://127.0.0.1:<port>/mcp`
   (the port is in `$HELM_HOME/serve.json`).

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
| `worker.spawn` | Create a worktree on a new branch and start a Pi worker on it. |
| `worker.inspect` | State, head, spend, diff stat, result and recent events for one worker. |
| `worker.list` | One line per worker. |
| `worker.steer` | Send a follow-up message to an idle or interrupted worker in the same Pi session. |
| `worker.stop` | Ask a running worker to stop. |
| `gate.run` | Run the repo's checks in the worktree at its exact head and record the result. |
| `pr.open` | Push the branch and open a PR. Refused unless a gate passed at the current head. |
| `pr.status` | Mergeability, checks and reviews from GitHub. |
| `review.request` | Spawn a read-only reviewer on the PR head with a different model; posts the verdict as a PR comment. |
| `run.status` | Spend, cap, active workers. |
| `pr.merge` | Merge only when the PR is open, mergeable, checks are green and the head matches. |

Every tool returns `{ ok: true, ... }` or `{ ok: false, reason }`. Nothing throws across the
boundary.

## What a worker can and cannot do

Workers get Pi's built-in tools: read, bash, edit, write, grep, find, ls. A `tool_call` hook
refuses anything outside the worktree, writes under `.git/`, writes under
`.github/workflows/` unless the spawn allowed it, and shell commands that push, call `gh`,
touch worktrees, check out other refs, or `rm -rf /`. Reviewers additionally cannot write.
Refusals are logged as events and shown to the model as the tool result.

A worker's final message must be one JSON object: `status`, `summary`, `changedFiles`,
`commandsRun`, optional `notes`. One correction turn is allowed; after that the worker is
marked failed and the raw text is saved.

Gates come from `<repo>/helm.json` (`{ "gates": [{ "name", "command" }] }`) or default to
the `test`, `typecheck` and `lint` scripts in `package.json`.

## Durability and cost

Everything is in `$HELM_HOME/helm.sqlite`: workers, events, gates, prs, spend. Worktrees
are under `$HELM_HOME/worktrees/`, captured gate output under `$HELM_HOME/logs/`, Pi session
files under `$HELM_HOME/sessions/`. If the daemon dies, running workers become
`interrupted` on the next start and `worker.steer` resumes their Pi session. Nothing is
replayed automatically.

Spend is summed from Pi usage events times the model's catalogue price. `HELM_SPEND_CAP_USD`
refuses new spawns and stops running workers at the next tool call once reached. Models
with no price are counted as tokens and reported as unknown-cost events, never blocked.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELM_HOME` | `~/.helm` | State directory |
| `HELM_SPEND_CAP_USD` | `0` (no cap) | Run-wide spend cap |
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
