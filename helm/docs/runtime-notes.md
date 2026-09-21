# Runtime implementation notes

Detailed module notes collected here to keep inline comments concise. Runtime behavior is unchanged by this documentation consolidation.

## helm.ts

Runs `fn` and turns any thrown error (including one from `must`/`requireValue` below) into `{ ok: false, reason }`, so every tool method can express a refusal as a plain throw.

Returns `value`, or throws `reason` when it is null/undefined. The "find X or refuse" helper: used for every worker/PR lookup so the refusal message is written once at the call site.

Model family for review independence: the leading letters of the last path segment of the model id, ignoring the provider prefix. 'opencode-go/qwen3.8-flash' -> 'qwen', 'openrouter/nvidia/nemotron-3-ultra:free' -> 'nemotron', 'openai-codex/gpt-5.6-luna' -> 'gpt', 'google/gemini-3.8-flash' -> 'gemini'.

The admission-and-create section of spawn, always run under `this.lock` so maxWorkers, idempotencyKey and worktree creation cannot race with a concurrent spawn/steer. `onDone` is set only by reviewRequest, which calls this directly to post its result as a PR comment.

Blocks until any of the workers leaves an active state, or the timeout passes. This is how an orchestrator waits without polling: one call per state change rather than one every few seconds. The store is re-read every `waitPollMs` in-process, which costs the caller nothing.

## github.ts

`gh` reports a check run with upper-case `status`/`conclusion` (`COMPLETED`, `SUCCESS`) and a commit-status context (Vercel and friends) with only `state`. Both come out lower-case, with `status: 'completed'` only once the check has actually finished and `conclusion` null until then, so the merge guard can tell "still running" from "failed" and never compares cases.

## prompt.ts

Builder and reviewer prompt text, plus the WorkerResult instruction appended to every turn. See DESIGN.md and docs/one-shot-brief.md section 5.

## gate.ts

`check.name` is attacker/author-controlled free text used to build a log file path; sanitize it before it ever reaches `outputPath` (F8). Anything outside [A-Za-z0-9._-] becomes a single '-', runs of '-' collapse, and leading dots are stripped (a name of just ".." would otherwise realize as the parent directory).

## cli.ts

The `helm` command line. Reads (ps, logs, inspect, status) open the store directly; writes POST to the running `helm serve --http` daemon. See DESIGN.md.

Shared shape for the thin read commands: parse args, open the store, run, close the store. `run` prints its own output (JSON or text); a `run` that never returns (e.g. `logs -f`) simply leaves the store open, same as the write commands leave the daemon call outstanding.

`serve --http` is the daemon. `serve --stdio` is a front-end for one MCP client: it attaches to the running daemon, or starts one detached first, and exits when its client does. The daemon outlives sessions on purpose — workers keep running and the dashboard stays up — and every project on the machine shares it. `helm shutdown` stops it.

## types.ts

Shared contracts for the Helm harness. Every module codes against these. Keep this file small; if a type is used by one module only, it lives there.

`status` is lower-case and is `completed` only when the check has finished; `conclusion` is lower-case and null until then, for check runs and commit-status contexts alike.

The Pi session file, reported as soon as it is opened rather than when the turn returns. A turn that is killed never returns, and resume needs this path to reopen the same session.

## tools.ts

The tool registry: maps the twelve tool names to their zod input schemas and dispatches validated calls to a Helm instance. Never throws; unknown tools and invalid input both come back as { ok: false, reason }. See DESIGN.md.

## ui.ts

Live read-only dashboard shell for GET /. A single self-contained HTML document (inline CSS + vanilla JS, no external resources) that polls the loopback JSON endpoints: /api/state and /api/events every 2s, /api/worker/<id> when a row is clicked. All dynamic text goes through textContent, never innerHTML.

## codex.ts

Codex CLI runtime: one `codex exec` (or `codex exec resume <thread>`) process per turn, inside the worktree, on the operator's ChatGPT subscription. Models are named `codex/<model>[:<effort>]`, e.g. `codex/gpt-6-astra:medium`.  Codex's own sandbox is the whole policy on this lane: `workspace-write` for builders (writes inside the worktree only; `.git/` is refused by Codex, so Helm commits for the worker as it always has; no network unless HELM_CODEX_NETWORK=1), `read-only` for reviewers. Events arrive as JSONL on stdout and are mapped onto Helm's event kinds; the final message is read from `--output-last-message`. Spend is $0 by definition (subscription); tokens are still recorded. See DESIGN.md.

## server.ts

`helm serve`: exposes the tool registry over MCP (stdio and Streamable HTTP) plus a small loopback HTTP API the CLI uses. See DESIGN.md and one-shot-brief.md section 3.

An MCP front-end over stdio that forwards every tool call to the daemon on `port`. It owns nothing: no store, no workers. Any number of these can attach to one daemon, one per orchestrator session, and each exits with its client. Calls go over `node:http` rather than `fetch` because undici gives up on a response after five silent minutes, and `worker.wait` may hold a response open for twenty-five.

## worker.ts

Pi session runtime: creates one in-process Pi coding-agent session per turn inside a worktree, with Pi's built-in tools enabled, guarded by a `tool_call` extension hook that is the entire protected-path policy. Parses the model's final message into a `WorkerResult`, with one correction turn on malformed output. See DESIGN.md and docs/one-shot-brief.md section 5.  Pi packages are imported lazily, inside functions, never at module load time.

Accept strict JSON or a ```json fenced block. Strict-JSON-whole-message is tried first; if that fails, fenced blocks are tried from last to first, returning the first one that validates against the schema (an unrelated JSON fence elsewhere in the message must not shadow a valid result fence).

Tokenizer-based classifier for bash commands, exported so it can be unit tested without a Pi session. Finds every `git` invocation in the command (across `;`, `&&`, `||`, `|`, `( )`, backticks and `$(`), skips its option tokens (and the value argument of options that take one) to find the actual subcommand, and denies push/worktree/checkout(without `--` for the reviewer or `switch`)/switch regardless of how many flags precede it. This closes the `git -C .. push`, `git --no-pager push`, `git -C .. worktree remove` style bypasses that a flat `/git\s+push/` regex misses.

Resolve `rawPath` against the worktree and realpath it. When the path does not exist yet (the write tool's normal case), realpath throws; falling back to the lexical path there would let a symlink such as `evil -> /tmp` plus a write to `evil/x.txt` escape the worktree undetected. Instead walk up to the deepest ancestor that does exist, realpath that (resolving any symlink in the existing prefix), and re-append the remaining, not-yet-existing components before the containment check.

