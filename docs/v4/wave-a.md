# Helm v4.0 — Wave A: supervisor, inbox, watcher, Jev, Discord

Status: ready to dispatch. Owner: Nick. Scope: drops 1–3 + Jev module. Vision: VG Doc `jh7ean8k75h81m04mw51xbdtr18fapbw` (Software factory end state); drops deck `jh79vydawzpzf0f1v3mcgmg5rs8fae8d`.
Gate for every ticket: `npm test` + `npm run typecheck` in `helm/` (no lint script exists).
Tests use `node:test`, no network: fake `fetch`, fake `exec` (pattern of `ghGitHub(exec?)`), `:memory:` store.
`src/types.ts` is the contract; tickets that change it say so, and the coordinator reviews them.
Lanes (Nick, 2026-09-29): builders Codex only; reviews by Claude subagents outside Helm (posted as PR comments); Jev for judgement. Per-ticket lane lines below that name deepseek/gemini are superseded: use codex/gpt-6-luna.

## Design decisions (made here; reverse deliberately)

1. **Line cap.** `src/` is 3,088 vs a 3.1k cap; wave A adds ~1,100. A0 raises the cap to 4.3k (Nick approved wave A 2026-09-29). Each ticket carries a line budget.
2. **Config location.** Daemon-level `$HELM_HOME/helm.json` holds Jev, wake, watch, supervisor and Discord settings. The repo `helm.json` stays gates-only (workers can write it; it's committed). Webhook URLs are credentials: config names an env var only (`webhookEnv`); its value lives in `~/.config/helm/env` (KEY=value lines), loaded like `~/.config/typesafe/env`. The daemon's env is whichever session started it, so the file fallback is required.
3. **Event-sourced consumers.** Wake, watcher, triage and Discord never hook `helm.ts`; each reads `events` after a persisted cursor on a daemon tick. Restart-safe, decoupled.
4. **Project key = `repoSlug`** (owner/name, already on every worker). herdr workspace `label` (e.g. "helm 4") is a separate column. Pane ids compact, so they're never stored; the pane is re-resolved from the label at each wake.
5. **Ask = result status, not a Pi tool.** WorkerResult gains `status:"question"` + `question`; the worker goes to a new state `waiting`. Works identically on both lanes (Codex has no custom tools) and needs no Pi-extension work. Trade-off: a worker can only ask at end of turn.
6. **Host.** herdr primary: idle = `agent_status == idle` from `herdr workspace list`/`pane list`; delivery = `herdr pane run`. tmux fallback: `send-keys` + best-effort idle. To avoid colliding with a human typing, delivery also requires the visible prompt line to be empty (A8 verifies the heuristic).
7. **Rotation.** The supervisor can't type `/compact` into itself; it calls `supervisor.rotate`, and Helm types `/compact <focus>` when the pane is idle, then a "rotated: rerun startup" wake line.
8. **Tool names** follow the existing dot style: `inbox.list`, `inbox.reply`, `supervisor.register`, …

## Dependency graph (cap 3 workers)

    A0 ─┬─ A1 ─┬─ A5b
        ├─ A2 ─┼─ A3
        ├─ A5a ┘   A6a ── A6b (A1)
        └─ A7 (after A5a, A6a)
    A4 (skills repo) and A8 (orchestrator) any time; A8 findings feed A2/A3 fixes.

Round 1: A0, A4 (+A8 in parallel) · Round 2: A1, A2, A5a · Round 3: A3, A5b, A6a · Round 4: A6b, A7, A9 · then a live soak on one project with shadow on.

---

## A0 — v4 seams: cap, settings, cursors, daemon tick
**Why:** every other ticket needs config, a place for tables, and a background loop; doing it once avoids three-way conflicts.
**Scope:**
- `AGENTS.md`: raise the cap to 4.3k with date + reason.
- New `src/settings.ts`: `loadSettings(home)` reads `$HELM_HOME/helm.json`, zod-validated with defaults: `jev { shadow:true, model:"jev-latest", triageHumanAt:0.3, attentionAt:0.4, timeoutMs:5000 }`, `wake { minIntervalSec:120, maxPerHour:20 }`, `watch { tickSec:60, silenceMin:15, sameRefusal:5, attentionEverySec:180, cooldownMin:15 }`, `supervisor { command?:string, envelope?:string }`, `discord { projects: Record<slug,{webhookEnv:string}>, digestSec:60, maxPerHour:20 }`. Plus `loadEnvFile(path)` → map, never throws.
- `src/store.ts`/`types.ts`: add `Store.sql: DatabaseSync` so modules create their own tables (`CREATE TABLE IF NOT EXISTS`); add a `cursors(name PK, seq)` table + `getCursor/setCursor`.
- New `src/daemon.ts`: `consumer(store, name, fn(events))` reads `listAllEvents` after the stored cursor and advances it; `startTicker(ms, fns)` returns a stop function; tests call `tick()` manually.
- `types.ts`: widen `ToolName` to `string` so modules can export tool defs that `tools.ts` concatenates.
- `cli.ts cmdServe`: start the ticker.
**Acceptance:** missing or invalid `helm.json` → defaults (invalid logs one line, no crash); a consumer processes each event exactly once across a store reopen; existing tests pass.
**Out:** any feature logic. **Size** S (~120 lines). **Lane** codex/gpt-6-luna:high (touches the contract).

## A1 — Jev client + call log
**Why:** Jev is the shared cheap-judgement service for triage and the watcher; every call must be logged for calibration.
**Scope:** new `src/jev.ts`: `createJev({ settings, store, env, fetch? })` → `ask(purpose, { workerId?, project?, state, questions })`.
- Key: `TYPESAFE_API_KEY`, else parsed from `~/.config/typesafe/env`; no key → `{ok:false, reason:'no key'}` and no network call.
- `POST https://api.typesafe.ai/v1/systemone`, body `{model, state, questions}`, header `Authorization: Bearer`; retry 429/5xx up to 2 times with backoff; timeout `jev.timeoutMs`.
- Question types: noul `{type:'noul', instructions, criteria?:{true,false}}` → `answers[k].noul`; choice `{type:'choice', instructions, criteria:{option:description}}` → `.choice/.confidence/.probabilities`; score `{type:'score', instructions, criteria:[ordered levels]}` → `.score/.confidence`.
- Table `jev_calls(id, at, purpose, workerId, project, model, questions, answers, confidence REAL, latencyMs, inputTokens, shadow INT, error, label TEXT NULL)`; `label` is filled later for calibration; `confidence` is the caller-supplied primary number. Export `jev.shadow` for callers.
**Acceptance:** fake fetch → answers + one row; no key → no fetch, `{ok:false}`; 500 then 200 → the retry succeeds; the key string appears in no row, error or thrown text (test with a sentinel key).
**Out:** callers (A5b, A6b). **Size** S (~100). **Lane** openrouter/deepseek/deepseek-v4.1-flash. **Deps** A0.

## A2 — Supervisor registry + wake delivery
**Why:** the supervisor is an interactive session; Helm must nudge it without typing over Nick.
**A8 findings (binding, see helm/evidence/v4-a8.md):** herdr reports `done` after a turn and `idle` later, so treat `idle` OR `done` as idle (`working`/`blocked` = busy). `promptEmpty` must read with `--ansi`: the prompt is empty if nothing follows `❯` or only faint-styled (`ESC[2m`) placeholder text does.
**Scope:**
- New `src/host.ts` (injectable `exec`): `herdrHost` and `tmuxHost` implementing `resolve(label) → pane|null`, `status(pane) → idle|busy|unknown`, `promptEmpty(pane)`, `send(pane, line)`, `create(label, cwd, command)` (used by A3).
  - herdr: `workspace list` (JSON; match `label`) → `pane list --workspace <id>` → `pane read <pane> --source visible --lines 8` (prompt line has no text after the `>` glyph) → `pane run`.
  - tmux: session `helm-<slug-with-dashes>`; `capture-pane -p` twice 2s apart; `send-keys -l` then `Enter`.
- New `src/supervise.ts`: tables `supervisors(project PK, repo, host, label, createdAt, lastWakeAt)` and `wakes(id, project, kind, workerId, summary, command INT, createdAt, deliveredAt, ackedAt)`.
- A consumer maps events → wakes. Kinds: `ask`, `watch.alert`, and `state` with `to` ∈ {succeeded, failed, idle, waiting, unknown, stopped}. Projects with no supervisor are ignored.
- Delivery tick, per project with undelivered wakes. Deliver only if all of: `now - lastWakeAt ≥ minIntervalSec`; under `maxPerHour`; the pane resolves; status is idle; the prompt is empty.
  - Send ONE line, e.g. `helm: 3 new for owner/repo (2 ask, 1 watch.alert). Call wake.list.` (ASCII, no newlines) and mark all pending as delivered.
  - A `command` wake (from rotate) is typed verbatim, alone.
  - Busy → defer, never drop. An undelivered wake older than 30 min → one daemon.log line.
- Tools: `supervisor.register {project, repo, host, label}` (upsert); `supervisor.list`; `wake.list {project, ack?:true}` (returns unacked wakes and acks them); `supervisor.rotate {project, focus}` (queues `/compact <focus>`, then the line `helm: context rotated; run your startup read order.`).
- CLI: `helm supervisor register|list`; `helm wake <project> "<text>"` for manual tests.
**Acceptance (fake host):**
- A busy pane defers; the next idle tick sends exactly one coalesced line.
- A non-empty prompt defers.
- Two ticks within `minIntervalSec` send once.
- A pane id change is re-resolved by label.
- Rotate sends the `/compact` line and the follow-up as two separate deliveries.
- A tmux fallback test runs on a fake exec.
**Out:** pane creation (A3), Jev and watch rules. **Size** M (~260). **Lane** codex/gpt-6-luna:high. **Deps** A0.

## A3 — `helm supervisor start <project>`
**Why:** one idempotent command that brings up, or reattaches, a project's owner session.
**Scope:** `src/cli.ts` + the `create` in `host.ts`. `helm supervisor start <owner/name> --repo <abs path> [--host herdr|tmux] [--label text]`. `--repo` and `--label` are needed only the first time; later runs read the registry. Host defaults to herdr when `herdr status server` succeeds, else tmux.
- Command: `supervisor.command` from settings, else `<claude> --remote-control '<label>' "Use the helm-supervisor skill. You are the supervisor for <slug>. Run its startup read order."`. `<claude>` = `$HELM_CLAUDE_BIN` → `~/.local/bin/claude` → `claude`.
- Idempotent:
  - Workspace exists and its root pane has a detected agent → print `attached <label> <pane>`, no change.
  - Workspace exists but no agent → `pane run` the command.
  - No workspace → `workspace create --cwd <repo> --label <label> --no-focus`, then `pane run` on `result.root_pane.pane_id`.
- Then start the daemon if down (reuse `startDetachedDaemon`) and POST `supervisor.register`.
- Preflight warnings (not failures): repo `.mcp.json` has no `helm` server; skill not installed at `~/.claude/skills/helm-supervisor`.
**Acceptance (fake exec):** start twice → creates once, attaches once; a dead agent in an existing workspace → the command re-runs; register is called with the label.
After launch, warn if `agent_status` is `blocked` (e.g. Claude's folder-trust prompt).
**Out:** restarts of a live session (rotation is compact-only). **Size** S (~90). **Lane** google/gemini-3.8-flash. **Deps** A2.

## A4 — Supervisor skill (`~/code/skills/helm-supervisor/SKILL.md`, separate repo)
**Why:** the owner contract has to live somewhere that survives `/compact`.
**Content outline:**
1. **Owner contract.** You own `<slug>`. Never exit. Never hand-edit code in the main checkout: workers build, you decide. Workers never talk to each other; you are the only router. Stay inside the envelope (code, tests, branches, local/dev resources); merging follows Helm rules.
2. **Startup read order.** `$HELM_HOME/supervisors/<slug>/handoff.md` → `supervisor.list`, `run.status` → `worker.list` (active + waiting) → `inbox.list` → `wake.list {ack:true}` → `gh issue list` / `gh pr list` for the repo → project memory. Then state the plan in 5 lines. The MCP server should use `HELM_TOOLS=core` (or `serve --tools core`) by default; use `helm.help` to discover less-common tools and `helm.call` to invoke them without expanding the session's advertised list.
3. **Wake events.**
   - `ask`: read the triage. needs_human → `notify.nick` and wait; otherwise answer with `inbox.reply`.
   - Settled, succeeded → `gate.run` → `pr.open` → `review.request` (other family) → `pr.merge` when green.
   - Failed/unknown → `worker.inspect`, one steer, else respawn with a narrowed objective.
   - `waiting` → treat as ask.
   - `watch.alert`, by rule: silence → inspect, then stop and respawn; refusal loop → steer with the policy; spend.warning → stop spawning and notify.
4. **Never block chat.** No `worker.wait` longer than 60s; wakes replace polling.
5. **Context rotation.** After each merged batch, or at ~60% context: write the handoff (goal, open tickets, active workers, decisions, next step), then call `supervisor.rotate`.
6. **Ping Nick** only for: needs_human, anything outside the envelope, spend.warning, a ticket that failed twice, or product-intent ambiguity. Routine progress goes to Discord automatically.
**Acceptance:** tool names match this file; every wake kind has a handling rule. **Size** S. **Lane** orchestrator-written. **Deps** none.

## A5a — Worker ask, `waiting` state, inbox
**Why:** a worker blocked on a decision should pause and ask instead of guessing.
**Scope:**
- `types.ts` (contract): `workerResultSchema.status` adds `"question"` plus `question?: string` (max 4000; required when status is question, via `superRefine`); `WORKER_STATES` adds `waiting`.
- `prompt.ts`: add one paragraph to `RESULT_INSTRUCTION`: if a decision isn't settled by the objective, or needs anything outside the worktree, end with status `"question"` and one concrete question.
- `helm.ts runTurn`: `question` → state `waiting`, committing as for `partial`; insert an inbox row; emit `ask {inboxId, question}`. `STEERABLE_STATES` includes `waiting`. A steer on a worker with an open question marks it `superseded`.
- New `src/inbox.ts`: `inbox(id 'q-'+hex, workerId, project, question, state open|answered|superseded, answer, answeredBy, triage JSON NULL, createdAt, answeredAt)`.
- Tools: `inbox.list {project?, state?='open'}`; `inbox.reply {id, answer, by?='supervisor'}` (checks the question is open and the worker is `waiting`, then steers with `Answer to your question: <answer>\nContinue the objective.`).
- CLI: `helm inbox [--project]`, `helm reply <id> "<text>"`. `ui.ts`: show `waiting` like `idle`.
**Acceptance:**
- A fake runner returning a question → state `waiting`, one inbox row, one `ask` event.
- `worker.wait` returns on `waiting`.
- A reply resumes the same `sessionFile` and marks the row answered.
- A reply to a non-waiting worker is refused.
- Both Pi and Codex parsing accept a question result (a `parseWorkerResult` case + a Codex fake-JSONL case).
**Out:** Jev triage, auto-answering. **Size** M (~150). **Lane** codex/gpt-6-luna:high. **Deps** A0.

## A5b — Jev triage of questions (shadow)
**Why:** most questions never need Nick; the rare ones that do must never be missed.
**Scope:** in `src/inbox.ts`, a consumer on `ask` makes one Jev call (purpose `triage`). State = envelope (`supervisor.envelope` or the built-in default) + objective + acceptance + question. Questions:
- `route` (choice):
  - answer_from_issue: "the issue text already states the answer, or the envelope explicitly permits the action"
  - needs_supervisor: "a judgement call, scope question, conflict or tooling problem not settled by the issue, and inside the envelope"
  - needs_human: "outside the envelope: production data or migrations, spending money, deleting data, secrets, merging or force-pushing main, provider settings"
- `outside` (noul): "Would acting on this require an action outside the autonomy envelope?"
- `inIssue` (noul): "Does the issue text or envelope already contain the answer?"

Decision:
1. needs_human if `max(P(needs_human), outside) ≥ triageHumanAt (0.3)`.
2. Else answer_from_issue if the route is answer_from_issue with confidence ≥ 0.9 and outside < 0.2.
3. Else needs_supervisor.

Store the result on `inbox.triage` with `shadow`. In wave A routing never changes: every ask still wakes the supervisor. No key → `{route:'needs_supervisor', reason:'no key'}`.
**Acceptance (fake jev):** P(human) 0.35 → needs_human; outside 0.5 with route answer_from_issue → needs_human; 0.95 confidence with outside 0.1 → answer_from_issue; no key → default; a `jev_calls` row is written with its confidence.
**Size** S (~70). **Lane** openrouter/deepseek/deepseek-v4.1-flash. **Deps** A1, A5a.

## A6a — Watcher: code rules
**Why:** Jev is blind to silence and spend; those need code rules.
**Scope:** new `src/watch.ts`, ticking every `watch.tickSec`. Rules:
- `silence`: a running worker with no event for `silenceMin`.
- `refusal.loop`: the same `tool.refused` reason at least `sameRefusal` times since the last `turn.start`.
- `spend.warning`, `error`, `result.invalid`: consumed from events.

Each emits `watch.alert {rule, detail}` on the worker. Dedupe (worker, rule) within `cooldownMin`; silence alerts once per run.
**Acceptance:** rules fire on synthetic event streams with a fake clock; no re-alert inside the cooldown; A5a's `waiting` workers never trigger silence.
**Size** S (~110). **Lane** google/gemini-3.8-flash. **Deps** A0 (wake comes from A2 via the event).

## A6b — Watcher: Jev attention (shadow)
**Scope:** in `watch.ts`, check running workers that have at least 8 `tool.call` events since `turn.start` and new events since their last check, at most once per `attentionEverySec`.
- Window: the last 30 events, compacted to one line each (`call bash: <summary>`, `REFUSED edit: <reason>`, `state a->b`, `notice: …`), with worktree paths stripped.
- Facts line: run age; minutes since the last edit, commit or test; refusals in the window; the highest count of any single refusal reason; edits in the window.
- Policy note: "Helm blocks gh, git worktree/checkout and paths outside the worktree; reviewers are read-only; occasional single refusals are normal."
- Question: `attention` (noul) "Does this worker need its supervisor to intervene now?", with true = "stuck, looping, blocked by policy, off-task, destructive, or heading toward failure" and false = "routine progress: reading, editing, testing, committing".
- If attention ≥ `attentionAt`: shadow on → emit `watch.shadow`; shadow off → emit `watch.alert {rule:'jev.attention', attention}`.
**Acceptance:** the compactor has a snapshot test; fake jev 0.45 in shadow → `watch.shadow` and no wake; shadow off → `watch.alert`; checks are rate-limited.
**Size** S (~90). **Lane** openrouter/deepseek/deepseek-v4.1-flash. **Deps** A1, A6a.

## A7 — Discord milestones
**Why:** Nick sees progress without spending tokens or opening the session.
**Scope:** new `src/discord.ts`, a consumer that maps events to milestones:

| Milestone | Source event |
| --- | --- |
| PR opened | `pr` |
| Merged | new `pr.merged` event (one line added in `helm.ts prMerge`) |
| Stall | `watch.alert` |
| Spend 80% | `spend.warning` |
| Needs Nick | `inbox.triage.route == needs_human` (the flag is posted even in shadow) |
| Worker failed | `state` to failed/unknown |

- Per-project webhook via `discord.projects[slug].webhookEnv`; the value comes from env or `~/.config/helm/env`. Projects without a webhook are skipped.
- One message per project per `digestSec`, lines grouped. Past `maxPerHour`, post one "muted for N min" line.
- POST `{content, username:'Helm', allowed_mentions:{parse:[]}}` with an injectable fetch.
- Tool `notify.nick {project, text}` posts immediately, rate-limited to 1/min.
- Failures go to daemon.log only, never with the URL.
**Acceptance:** events map to the milestones above; bursts coalesce into one post; the hourly cap holds; a sentinel webhook URL never appears in logs, events or errors; missing config is a no-op.
**Size** M (~140). **Lane** google/gemini-3.8-flash. **Deps** A0, A5a (triage row), A6a.

## A8 — Spike: remote control and injection (orchestrator, manual)
In one herdr workspace running `claude` with remote control on:
1. How to enable remote control at launch (flag or typed command); record it for A3.
2. After `/compact` is typed by `herdr pane run`, does the phone session still receive?
3. After quitting and restarting Claude in the same pane: is the phone link the same, re-paired, or lost? Record the steps.
4. `agent_status` flips to working while a phone message runs (so the wake defers).
5. With half a line typed locally and status idle, A2's prompt-empty check detects the draft and defers; record the prompt glyph and the `pane read` output.
6. A phone message arriving just after a wake line queues cleanly.
Output: `helm/evidence/v4-a8.md` with pass/fail per check and any A2/A3 changes. **Deps** none (A2's `helm wake` makes check 5 easier).

## After wave A
Soak on one project for 2–3 days with shadow on. Then label `jev_calls` from outcomes and decide whether to turn shadow off for triage (auto answer_from_issue) and attention.

## A9 — Spend budgets per project and per sprint
**Why:** the lifetime `HELM_SPEND_CAP_USD` blocks every project once the all-time total crosses it (it blocked round 2 on 2026-09-29). Budgets should follow the work: per project, ideally per sprint.
**Scope:**
- New `src/budget.ts`, table `budgets(id 'b-'+hex, project, label, capUsd REAL, capCodexTokens INTEGER NULL, openedAt, closedAt NULL)`. Codex spend is recorded as $0, so a budget also caps Codex tokens (input+output from the spend table) when `capCodexTokens` is set; either limit exhausts it. `budget.open` takes optional `codexTokens`; `budgets.defaultCodexTokens` in settings (default 20,000,000). At most one open budget per project; opening a new one closes the previous.
- A worker's spend counts against the budget that was open for its project (`repoSlug`) when it was spawned: store `budgetId` on the worker via a `worker_budget(workerId PK, budgetId)` table, so `types.ts` stays unchanged.
- Spawn and steer checks, in `helm.ts` next to the existing cap:
  - refuse `budget exhausted (<label> $spent/$cap)` when the project's open budget is spent;
  - with no open budget, use the default per-project sprint cap `budgets.defaultCapUsd` in `$HELM_HOME/helm.json` (settings default 25), opening an implicit `auto-<date>` budget;
  - the soft warning at 80% of the budget emits `spend.warning` with `{project, label}`.
- The lifetime `HELM_SPEND_CAP_USD` stays as a global backstop only. Document in README that 0/unset means no global cap.
- Tools: `budget.open {project, label, capUsd}`, `budget.close {project}`, `budget.status {project?}` (spent, cap, remaining, workers). `run.status` adds a per-project section.
- CLI: `helm budget open <project> <label> <cap>`, `helm budget close <project>`, `helm budget [project]`.
**Acceptance:**
- Spend on two projects is tracked independently; exhausting one budget refuses spawns there but not on the other.
- Opening a new sprint resets the available budget; old spend stays attributed to the closed budget.
- An implicit budget is created at the default cap when none is open.
- The 80% warning fires once per budget.
- The global cap still refuses when set and exceeded.
- Existing spend tests pass.
**Size** M (~140). **Lane** codex/gpt-6-luna:high. **Deps** A0.
