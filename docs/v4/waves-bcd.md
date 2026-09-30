# Helm v4.0 — Waves B, C, D: specify+gate, ship, remember

Status: plan, dispatch after wave A (A0–A9) lands. Owner: Nick. Scope: drops 4–9. Same gate/test/contract rules as `wave-a.md`.
Lanes: builders **Codex only** (`codex/gpt-6-luna:high` for contract/concurrency work, `:medium` otherwise). Reviews by Claude Code subagents run by the supervisor outside Helm, recorded with `review.record` (B7). Jev for cheap judgement. Skills are supervisor/orchestrator-written in `~/code/skills`.
Jev wording and thresholds come from the spike (`helm3-worktrees/jev/spikes/jev/results/*.md`, branch `spike/jev`, not pushed). The wording quoted below is verbatim; retuning needs a new spike.

## Decisions forced by the code (recommendation first; reverse deliberately)

1. **Line cap.** `src/` is 3,234 after A0. Wave A + A9 lands at ~4.3k (the cap). B adds ~930, C ~670, D ~530. B0 raises the cap to 5.3k. B10 retires the Pi lane (~−400: `worker.ts` plus lane plumbing, which Codex-only makes dead code). C0 raises the cap to 5.6k and D0 to 6.1k, each dated in AGENTS.md. If Nick declines B10, the caps are 5.3k/6.0k/6.5k.
2. **Codex-only defaults.** `helm.ts` still defaults to `terra:medium`, qwen flash (super-easy) and a gemini reviewer. B0 sets normal → `luna:high` and easy/super-easy → `luna:medium`; `review.request` without a model is refused ("record Claude reviews with review.record").
3. **Budgets meter Codex tokens.** Codex spend is recorded as $0, so A9 carries `capUsd` and `capCodexTokens`. The envelope (B4a) only references budgets.
4. **A tap has to come from a human.** The supervisor can type anything, including `helm` CLI calls. A tap is a one-time 6-digit code that Helm posts to a Discord webhook channel (`discord.tapWebhookEnv`) that the supervisor's Claude/Discord plugin cannot read. Nick reads it and says it in chat. Codes are hashed, single-use and expire after 60 min.
5. **Envelope lives in `$HELM_HOME`, not the repo.** Workers can write the repo. Helm hashes the envelope file on each tick; a change emits `envelope.changed`, which A7 posts to Discord, so a widening is visible even though the supervisor has a shell.
6. **Merge queue updates by merge, not rebase.** A rebase needs a force-push (a hard-rule action), and PRs squash-merge anyway. Helm runs `git merge origin/<base>` in the worktree. Materiality is mechanical: if `git diff base...head | git patch-id --stable` is unchanged, the approval carries over; any change means re-review.
7. **Gate-first branching.** The builder branches from the validator's test commit, but the PR must target the real base: B5b stores `prBase` in `worker_meta` and `prOpen` reads it.
8. **Module-owned extension tables,** not new `WorkerRow` columns: `worker_meta(workerId PK, issue, prBase, baselineId, band, complexity, skills JSON)`. Project-level events use `workerId = "project:<owner/name>"`; B0 adds `projectOf(event)` and extends A2's wake mapping to them.
9. **Guard seam.** B4–B7, C1 and D5 each need to refuse or alter `spawn`/`pr.open`/`pr.merge`. B0 adds `helm.guard(tool, fn)` (returns a refusal reason or null; run in registration order) and `helm.chooseModel(fn)`, so no two tickets edit the same `helm.ts` method.
10. **The envelope guard fails closed.** Order: hard rules (code), then the envelope file, then Jev; no key or a Jev error means tap. Claims and verdict checks with no key are skipped with a `warning`: an unknown is reported, never blocked, as with prices.
11. **The claims gate blocks from day one** at p(supports) ≥ 0.7 (spike: 79/79 and 58/58). A false fail costs one named retry (B8). Triage and attention stay in shadow per wave A.
12. **Vercel projects wired to git.** Nick's apps (VG, CG) auto-deploy on push. The Vercel adapter supports `mode: "git"` (observe the GitHub deployment for the sha, smoke it, roll back via the CLI) as well as `mode: "cli"`.
13. **Common Ground** is deployed (CG CLAUDE.md, 2026-09-29), but its first real run (go-live §5) and API key are pending, so treat it as not live. Memory writes go to a local mirror plus an outbox, using the CG page shape and CG paths `projects/<repo-name>/<type>/<slug>.md`. Fix `factory/projects/<name>` in the supervisor skill.
14. **Skill injection needs an allowlist.** Most skills are written for Claude (herdr, VG MCP). D4 offers only skills listed in `select.skillAllow` to Codex workers, inlining them into the prompt.

## Line budget and cap (AGENTS.md)
| Wave | Adds | Cap after |
| --- | --- | --- |
| A + A9 | ~1.2k | 4.3k (set) |
| B | ~930, −400 (B10) | 5.3k (B0) |
| C | ~670 | 5.6k |
| D | ~530 | 6.1k |

---

# Wave B — drop 4 Specify, drop 5 Gates

    B0 ─┬─ B2 ── B3(skill, +B1)
        ├─ B4a ── B4b (A7, A9)
        ├─ B5a ── B5b ─┐
        ├─ B6 ─────────┼─ B8
        └─ B7 ─────────┘
    B1 (skill) any time · B9 (skill) after B8 · B10 NEEDS-NICK last

Round 1: B0, B1 · Round 2: B2, B5a, B7 · Round 3: B4a, B5b, B6 · Round 4: B4b, B8, B3 · Round 5: B9, then B10 (NEEDS-NICK) and live verification.

## B0 — B/C/D seams: settings, repo config, guards, worker_meta, Codex defaults
**Why:** do the shared edits once, as A0 did, so later tickets don't conflict.
**Scope:**
- AGENTS.md: cap 5.3k (dated).
- `settings.ts` adds:
  - `factory { claims:'off'|'shadow'|'block'='block', claimsAt:0.7, verdictAt:0.5, retryMax:2, envelopeTapAt:0.5, tapTtlMin:60 }`
  - `queue { tickSec:30, checksTimeoutMin:30 }`
  - `memory { dir?, cg?:{ url, keyEnv, enabled:false } }`
  - `select { skillDirs:['~/code/skills'], skillAllow:[], autoAt:0.7, lessons:'shadow' }`
  - `routing { table, allowed, minClean:0.5, minN:8 }`
  - `discord.tapWebhookEnv?`
- New `src/repoconfig.ts`: `loadRepoConfig(repo, sha?)` reads the repo `helm.json` at a sha (`git show sha:helm.json`, falling back to the worktree), zod-parsed: `gates`, `acceptance { testGlobs, command? }`, `deploy { targets[] }` (schema only; C2 fills it in). `gate.ts defaultChecks` uses it.
- `helm.ts`: `guard(tool, fn)` for `worker.spawn`/`pr.open`/`pr.merge`, and `chooseModel(fn)` run before the spawn lock. Codex-only defaults (decision 2).
- `worker_meta` table with `getMeta/setMeta`; `projectOf(event)`; A2's wake kinds become a registry that modules append to.
- `types.ts` (contract): `spawnInput.issue?: number`; `WORKER_ROLES += 'validator'`; `workerResultSchema` gains `claims?: string[]` (≤12, each ≤300 chars) and `acceptance?: {command, files[]}`.
**Acceptance:** a guard that returns a reason refuses `pr.merge` with that reason; with no chooser, spawn uses `luna:high`; `review.request` without a model is refused; a repo `helm.json` read at a sha ignores worktree edits; existing tests pass.
**Out:** feature logic. **Size** M (~120). **Lane** codex luna:high. **Deps** wave A.

## B1 — Skill `factory-plan` (`~/code/skills/factory-plan/SKILL.md`)
**Why:** specs start as a conversation with Nick and end as a deck he marks up by phone.
**Content:**
1. Grill Nick (the `grilling` skill): goal, users, non-goals, constraints, the envelope and budget for the sprint.
2. `vg_guide`, then build the deck: 3–6 strategy slides (problem, outcome, scope in and out, risks, sprint budget and deploy targets), then **one HTML wireframe slide per feature**. Each wireframe slide has a real layout mock plus a speaker-notes block: `feature`, `acceptance` (observable, checkable), `files hint`, `depends on`.
3. `vg_push_deck` → `vg_wait_for_review`; apply pins and edits; loop until Nick approves.
4. Output: the deck id and the feature list. Record the deck id on the project map issue.
**Acceptance:** one feature per slide; every feature slide has the notes block; only real VG tools are named. **Size** S. **Lane** supervisor-written. **Deps** none.

## B2 — `jev.check` tool + CLI (Jev for skills without the key)
**Why:** skills need Jev; only the daemon holds `TYPESAFE_API_KEY`.
**Scope:** new `src/jevcheck.ts`. Tool `jev.check { preset, project?, input }`; CLI `helm jev check --preset <p> --file <json|md> [--json]`. Every call goes through A1 `ask` and is logged to `jev_calls` with purpose `check.<preset>`. Presets use the spike wording:
- `issue`:
  - `testable` (noul): "Does this ticket state a concrete, checkable definition of done (specific commands, tests, files or observable behaviour an automated gate or reviewer can verify)?" Flag below 0.5.
  - `too_big` (noul): "Is this ticket too big or too multi-part for one coding worker in one session…?" Flag at ≥0.5.
  - `complexity` (score, four levels trivial/small/medium/large with the spike descriptions).
- `dedupe {candidate, against:[{number,title,body}] ≤40}`: one `relation` score per pair ("same unit of work … merely related … different"). Tickets are truncated to 3,000 chars; concurrency 4. P(same) ≥0.5 is a duplicate; "related" gets a link.
- `verdict {body}`: reused by B7.
- `raw {state, questions}`: at most 6 questions.
- Also tool `jev.label {id, label}` to fill A1's `label` column.
**Acceptance (fake jev):** `issue` returns flags at the thresholds; `dedupe` makes one call per pair and flags at 0.5; no key → `{ok:false,reason:'no key'}`; the key never appears in output.
**Out:** issue creation. **Size** S (~100). **Lane** codex luna:medium. **Deps** A1, B0.

## B3 — Skill `deck-to-issues` (`~/code/skills/deck-to-issues/SKILL.md`)
**Why:** turn the approved deck into tickets a worker can finish in one session.
**Content:**
1. `vg_get_deck`. For each feature slide, draft an issue: objective, acceptance (commands or observable behaviour), files hint, link to the deck slide.
2. `helm jev check --preset issue`: rewrite untestable drafts and split any flagged `too_big` (at most 2 rewrites, then ask Nick).
3. `gh issue list --state open --json number,title,body` → `helm jev check --preset dedupe`. For a duplicate, comment on the existing issue instead of creating one; cross-link related issues.
4. `gh issue create` under the map issue and add each to the map issue's checklist.
**Acceptance:** a duplicate feature produces no new issue; every created issue passes `testable`. **Size** S. **Lane** supervisor-written. **Deps** B1, B2.

## B4a — Per-project autonomy envelope
**Why:** the supervisor's limits should live in a file Helm enforces, not only in the skill. Spend is A9's job.
**Scope:** new `src/envelope.ts`. File `$HELM_HOME/projects/<owner>__<name>/envelope.json`, zod-validated:
- `rules: string[]`: plain sentences; the Jev state, and what the supervisor reads.
- `budget { maxSprintUsd, maxSprintCodexTokens }`: the most the supervisor may open itself via A9 `budget.open`. Above that, a granted tap is required (a B0 guard on `budget.open`). There is no separate spend cap.
- `deploy: Record<target, 'auto'|'tap'|'never'>`.
- `tapOnly: string[]` action kinds, e.g. `deploy.prod`, `convex.migration`, `dependency.major`, `external.message`, `skill.merge`, `merge.unreviewed`.
A missing file falls back to the wave-A built-in default text with every deploy set to `tap`. Tool `envelope.get {project}` → rules, summary, hash. A5b triage uses the project rules when present. The tick emits `envelope.changed` on a hash change, which A7 maps to Discord.
**Acceptance:** an invalid file → default plus one log line; opening a budget above the max without a tap is refused; one hash change emits exactly one event.
**Size** S (~70). **Lane** codex luna:medium. **Deps** B0, A9.

## B4b — Taps (human approval codes)
**Scope:** in `envelope.ts`, table `taps(id 't-'+hex, project, kind, action, actionHash, codeHash, state pending|granted|used|denied|expired, attempts, requestedAt, grantedAt, usedAt, expiresAt)`.
- `tap.request {project, kind, action}` posts "Tap needed for <slug>: <action>. Tell your supervisor: tap <id> <code>" to `discord.tapWebhookEnv`; refused if no tap channel is configured.
- `tap.confirm {id, code}`: 3 wrong attempts → denied. CLI `helm tap <id> <code>`.
- `consumeTap(project, kind, actionHash)`: single-use; used by B4a and C2/C3.
**Acceptance:** the code never appears in a tool result, event, row or log (sentinel test); reuse, expiry and a mismatched actionHash are all refused. **Size** S (~100). **Lane** codex luna:high. **Deps** B4a, A7.

## B5a — Validator worker + red baseline (gate-first)
**Why:** the acceptance test exists, and fails, before any feature code is written.
**Scope:**
- `prompt.ts validatorPrompt`: write only test files for the issue's acceptance; the test must fail on current code because the behaviour is missing; report `acceptance {command, files}`.
- New `src/baseline.ts`, table `baselines(id 'b-'+hex, repoSlug, issue, validatorId, baseRef, baseSha, testCommit, command, files JSON, red INT, outputPath, at)`.
- Tool `gate.baseline {workerId}`. Requires a succeeded validator with `result.acceptance`, and changed files ⊆ `acceptance.testGlobs` (otherwise refused, naming the files). Runs the command at the validator head and records red on a non-zero exit; a green run is refused ("test already passes").
**Acceptance:** fake gate exit 1 → a row with `red=1`; exit 0 → refused; a non-test file in the diff → refused. **Size** M (~130). **Lane** codex luna:high. **Deps** B0.

## B5b — Bind builders to a baseline
**Scope:**
- `spawnInput.baselineId?` (contract). The spawn uses baseRef = `testCommit` and sets `worker_meta.prBase = baseline.baseRef`.
- `gate.run` appends the check `{name:'acceptance', command}`.
- A `pr.open` guard requires that check to pass at head, and `git diff testCommit..head -- <files>` to be empty (tests untouched).
- `prOpen` uses `prBase`; the PR body says "red at <baseSha>, green at <head>".
**Acceptance:** the PR base is main, not the validator branch; an edited test file refuses pr.open naming the file; the acceptance check runs without being listed. **Size** S (~80). **Lane** codex luna:medium. **Deps** B5a.

## B6 — Claims vs diff (Jev)
**Why:** catch a builder that claims work its diff doesn't contain before anyone spends a review on it.
**Scope:** new `src/claims.ts`, table `claims_checks(workerId, head, passed, detail JSON, jevCallId, at)`. Tool `claims.check {workerId}`; requires a passing gate at head.
- Claims come from `result.claims`, else from `summary` sentences (≤8).
- Diff = `baseSha..head`, excluding lockfiles and snapshots. At ≤70k chars, batch all claims in one call; otherwise one call per claim with the diff trimmed to the paths it names, falling back to `changedFiles`.
- Question per claim (choice), instructions: "A coding agent summarised its own change and claimed: "<claim>" Judging ONLY from the git diff in the state, what does the diff say about this claim?"
  - `supports`: "The diff contains changes that make the claim true."
  - `contradicts`: "The diff touches the relevant code but it differs from the claim (different name, value, file, count, or the opposite change)."
  - `says_nothing`: "The diff contains no evidence about this claim either way."
- Pass when every claim has p(supports) ≥ `claimsAt` (0.7). Process claims ("tests pass", "committed") answered says_nothing are dropped and left to the gate. Every `changedFiles` entry must appear in the diff.
- `prompt.ts` asks for `claims` as atomic, diff-checkable statements.
- In `block` mode a `pr.merge` guard requires a pass at head. No key → warning.
**Acceptance (fake jev):** 0.69 → fail listing that claim; process claims are ignored; a missing changed file → fail; shadow mode never blocks. **Size** M (~120). **Lane** codex luna:high. **Deps** B0, A1.

## B7 — Review verdict: `review.record` + blocking merge
**Why:** reviews happen in Claude Code outside Helm; merge must still require one.
**Scope:** new `src/review.ts`, table `reviews(id, repoSlug, number, head, patchId, reviewer, stated approve|request_changes, jevApprove REAL, verdict approve|changes|disputed, commentUrl, at)`.
- Tool `review.record {number, head, commentUrl, reviewer, verdict}`. Helm fetches the comment through a new `GitHub.comment(slug, id)` (contract; `gh api repos/{slug}/issues/comments/{id}`), checks it belongs to that PR, requires `head` to equal the current PR head, and stores `patchId` for C1.
- Jev reads the verdict: noul "Does this code review approve the change for merge (as opposed to requesting changes)?" at `verdictAt` (0.5; spike 77/77, including with verdict tokens stripped).
- The verdict is approve only when the stated verdict is approve, Jev agrees, and the body's verdict line starts `APPROVE: `. Disagreement → `disputed` plus a wake. No key → the verdict-line rule alone decides.
- `pr.merge` guard: the latest review at head (or at the same patchId, C1) is approve, and the reviewer family differs from the builder's.
**Acceptance:** merge with no review → "no approving review at <head>"; "APPROVE blockers are items 1 and 2" with Jev 0.11 → disputed; a review at an old head doesn't count; a comment from another PR is refused. **Size** M (~130). **Lane** codex luna:high. **Deps** B0, A1.

## B8 — Same-session retry naming the violation
**Scope:** new `src/retry.ts`, table `retries(workerId, kind, n, at)`. Tool `worker.retry {workerId, kind?}`, kind ∈ gate|acceptance|claims|review|tests_edited|conflict (C1b); omitted → the latest recorded failure. Helm builds the message and steers the same session: "Your last turn was rejected: <kind>. <evidence>. Fix exactly this. Do not edit <test files>."
- Evidence: gate → failing check names plus a 40-line log tail; claims → the failing claims with Jev's choice; review → the comment body (≤6k).
- At most `retryMax` (2) per kind per worker, then refused with "respawn or ask Nick".
**Acceptance:** each kind's message carries its evidence; the third retry is refused; the session file is unchanged. **Size** S (~80). **Lane** codex luna:medium. **Deps** B5b, B6, B7.

## B9 — Supervisor skill: specify-and-gate loop
Update `helm-supervisor` (and the `helm` skill table):
1. Plan (B1), then issues (B3).
2. Per issue: validator → `gate.baseline` → builder with `baselineId` and `issue`.
3. On succeeded: `gate.run` → `claims.check` → `pr.open`.
4. Claude review subagent (brief = PR + issue + baseline) posts a comment ending `APPROVE: `/`REQUEST_CHANGES: `; the supervisor calls `review.record`.
5. `worker.retry` on any failure; merge.
Out-of-envelope actions go through `tap.request`, never Nick-by-chat alone. Fix the CG path. **Lane** supervisor-written. **Deps** B8.

## B10 — Retire the Pi lane (NEEDS-NICK: approve)
Tag `pi-lane-final`. Remove `worker.ts`, the Pi branch of `laneRunner`, `REVIEW_MODEL` paths, the Pi deps and README sections; remove `review.request` (replaced by `review.record`). **Acceptance:** tests pass; src ≤4.95k lines. **Size** M (−400). **Lane** codex luna:high. **Deps** B9 + one week with no Pi spawns.

## Wave B live verification (supervisor, sandbox repo)
1. Plan a 2-feature sprint; Nick reviews the deck. Compile it with a third, deliberately duplicate feature, which must not become an issue.
2. Validator on feature 1 → baseline red → builder → acceptance green, claims pass → Claude review recorded → merge.
3. Negatives:
   - `pr.merge` before review is refused.
   - A hand-added false claim fails, and `worker.retry` fixes it.
   - A builder edit to the test file is refused.
   - `budget.open` above the envelope max needs a tap; Nick receives the code on Discord and it works once.
4. `jev_calls` has rows for every preset.
**NEEDS-NICK:** a separate Discord tap channel and webhook the Claude bot is not in; the first envelope file per project; the B10 go-ahead.

---

# Wave C — drop 6 merge queue + deploy, drop 7 guard + delivery

    C1a ── C1b (B8)
    C3 (B4a, B4b) ── C2a ─┬─ C2b
                          └─ C2c
    C4 (skill, after C2a) · C5 (skill) last · C-NICK last

Round 1: C1a, C3, C4 · Round 2: C1b, C2a · Round 3: C2b, C2c, C5 · Round 4: NEEDS-NICK keys, then the live run. C0 is the dated AGENTS.md cap raise to 5.6k (orchestrator).

## C1a — Per-repo merge queue
**Scope:** new `src/queue.ts`. Git runs through an injectable exec, so the Workspace contract doesn't change.
- Table `merge_queue(id, repoSlug, number, workerId, state queued|updating|gating|checks|review|ready|merged|failed|conflict, head, reason, enqueuedAt, updatedAt)`.
- Tools `merge.enqueue {number}`, `merge.queue {project}`, `merge.dequeue {number}`.
- The tick processes one item per repo, serially:
  1. `fetch`. If the base moved: `git merge origin/<base>` in the worktree, commit, record the new head.
  2. `gate.run` (acceptance included).
  3. Push → `gh pr ready` → wait for checks (≤ `checksTimeoutMin`).
  4. Compare patch-ids: unchanged → the approval carries (B7 matches on patchId); changed → state `review` plus a `queue.review` wake.
  5. `prMerge(expectedHead)` (all guards run). Emit `queue.merged`/`queue.failed`.
- Never force-push.
**Acceptance (fake exec/GitHub):** two PRs on one repo merge in order; base moved with the same patch-id → no re-review; changed interdiff → review state; red gate → failed plus a wake. **Size** M (~160). **Lane** codex luna:high. **Deps** B7.

## C1b — Conflict fix + re-review
**Scope:**
- On a merge conflict, leave the `git merge --no-commit` markers and `worker.retry {kind:'conflict'}` the original builder session: same worktree and branch, so the PR stays the same. `commitAll` concludes the merge.
- Before re-gating, refuse any head that still has conflict markers (`git diff --check`), with a second retry.
- Missing worktree or a non-steerable worker → state `conflict` plus a wake.
- After a patch-id change, the item resumes once `review.record` approves the new head.
**Acceptance:** fake conflict → a retry message listing the files; leftover markers → a second retry, then conflict; approval at the new head resumes. **Size** S (~90). **Lane** codex luna:high. **Deps** C1a, B8.

## C3 — Envelope guard (hard rules → envelope → Jev)
**Scope:** in `envelope.ts`, tool `envelope.check {project, actions: string[] ≤13, kind?}` → per action `{decision allow|tap|never, source hard|envelope|jev, pTap}`.
1. **Hard rules** (code, not configurable): push or force-push to the base branch; `--admin`; reading or printing secrets; prod data delete, backfill or migration; `convex.migration` on prod; paid signup, plan or billing changes; provider account settings; messages to anyone but Nick; raising a budget; editing agent settings.
2. **The envelope file:** `tapOnly` kinds and deploy target modes.
3. **Jev noul per action,** batched as in the spike, with the envelope rules as state: "Proposed supervisor action: <a> Does this action fall outside the autonomy envelope, so it needs a tap from Nick before it runs? If any rule would require a tap, or the action is irreversible and not clearly allowed, answer true." Criteria: true = tap required; false = clearly allowed by the envelope. Tap at ≥ `envelopeTapAt` (0.5; spike 38/38 and 9/9 disguised).
4. No key or an error → tap.
`deploy.run` and the supervisor skill call this before every external action.
**Acceptance:** `git push origin +main` → tap from hard rules even with Jev at 0; Jev 0.49 → allow; no key → tap; a batch of 13 is one call. **Size** S (~90). **Lane** codex luna:high. **Deps** B4b, A1.

## C2a — Deploy core, smoke contract, Vercel adapter
**Scope:**
- Repo `helm.json` `deploy.targets[]`: `{name, kind:'vercel'|'convex'|'testflight', env, mode?, smoke:{commands?:[{name,command}], http?:[{path,status,contains?}]}, rollback:'auto'|'manual'|'none'}`, read at the deployed sha.
- New `src/deploy.ts`, table `deploys(id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke JSON, tapId, at)`.
- Tools `deploy.run {project, target, sha?, tapId?}` (sha defaults to the base head; non-preview deploys must be on the base branch), `deploy.status`, `deploy.rollback {id, tapId?}`.
- Flow:
  1. `envelope.check`; a tap decision is refused, naming the kind.
  2. A clean detached worktree at `$HELM_HOME/deploys/<slug>/<id>`.
  3. Run the adapter.
  4. Smoke: commands with `HELM_DEPLOY_URL` and a 5-min timeout, plus the HTTP checks.
  5. On failure with `rollback:'auto'`, roll back and emit `deploy.rolledback`; otherwise emit `deploy.failed` plus a wake.
- Credentials are env *names* resolved from env or `~/.config/helm/env`, and are redacted from all logs.
- Vercel `cli` mode: `vercel deploy [--prod] --yes --token` with `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`. Vercel `git` mode: poll `gh api repos/{slug}/deployments?sha=` until success and take the URL. Rollback: `vercel rollback <previous> --token` (prod only).
- A7 milestones for deploy, rolledback and failed.
**Acceptance (fake exec):** smoke failure → rollback called with the previous deployment; a non-base sha to prod is refused; the sentinel token appears in no log; a tap decision is refused, then succeeds with a granted tap. **Size** M (~180). **Lane** codex luna:high. **Deps** C3.

## C2b — Convex adapter
**Scope:**
- Deploy with `npx convex deploy` and the target's deploy-key env name (dev or prod keys).
- Migration detection: a diff between the target's last successful sha and the new sha that touches `convex/schema.ts` or `convex/migrations/**` (configurable) is kind `convex.migration`. On prod that is a hard tap and only proceeds with a matching tapId.
- Rollback: `redeploy-previous`, only when the failed deploy had no schema diff; otherwise manual plus a wake.
**Acceptance:** a schema diff on prod without a tap is refused; a code-only failure redeploys the previous sha. **Size** S (~80). **Lane** codex luna:medium. **Deps** C2a.

## C2c — TestFlight adapter (fastlane)
**Scope:**
- Run `bundle exec fastlane <lane='beta'>` in the deploy worktree, with env names for the ASC API key (`APP_STORE_CONNECT_API_KEY_PATH`) and `MATCH_PASSWORD`.
- Parse an explicit `HELM_BUILD_NUMBER=<digits>` marker printed by the Fastfile lane (or fastlane's exact build-number forms). Smoke = exit 0 plus optional commands. Rollback `none`.
- `testflight.external` (external testers) is envelope `tapOnly` by default.
**Acceptance:** a fake fastlane log → build number recorded; non-zero exit → failed with a redacted 40-line tail. **Size** S (~70). **Lane** codex luna:medium. **Deps** C2a.

## C4 — Skill `delivery-deck` (`~/code/skills/delivery-deck/SKILL.md`)
Runs at sprint close (A9 `budget.close`) or on request.
- Content: a VG deck covering shipped features (PR, preview URL, screenshot), deploys and rollbacks, gate, claims and review stats, spend and Codex tokens against budget, open issues, and asks for Nick.
- Data: `worker.list`, `gh pr list --state merged`, `deploy.status`, and `scorecard.export` once D2 lands.
- Publish: `vg_push_deck`; `vg_publish_deck` only after an envelope check (publishing is an external action).
**Lane** supervisor-written. **Deps** C2a.

## C5 — Supervisor skill: queue, deploy, guard
Replace direct `pr.merge` with `merge.enqueue`; handle the `queue.review`/`queue.failed`/`deploy.*` wakes; call `envelope.check` before any external action, then `tap.request` on a tap decision. **Lane** supervisor-written. **Deps** C1b, C2a, C3.

## Wave C live verification
1. Two sandbox PRs edit the same file and both are enqueued: the first merges; the second conflicts, gets a conflict retry, is re-reviewed (patch-id changed) and merges.
2. A third PR with only a base update merges without re-review.
3. A Vercel preview deploy of the sandbox with a deliberately failing smoke path auto-rolls back and posts a Discord line.
4. A Convex dev deploy with a schema change is allowed on dev; the same change on prod requires a tap.
**NEEDS-NICK (last):** `VERCEL_TOKEN` plus org/project ids; Convex deploy keys per project; an ASC API key and match access for one iOS app; a real TestFlight run.

---

# Wave D — drop 8 factory memory + scorecard, drop 9 selection + routing

    D1a ─┬─ D1b (NEEDS-NICK to enable)
         ├─ D4
    D2 ──┼─ D5
         └─ D3 (skill) · D6 (skill)

Round 1: D1a, D2 · Round 2: D1b, D4, D5 · Round 3: D3, D6 · Round 4: NEEDS-NICK CG go-live, then sync on. D0 is the dated AGENTS.md cap raise to 6.1k (orchestrator).

## D1a — Local memory mirror + outbox
**Scope:** new `src/memory.ts`.
- Mirror at `$HELM_HOME/memory/` (or `memory.dir`), using CG paths `projects/<repo-name>/<type>/<slug>.md` and `team/<type>/<slug>.md`.
- CG page shape: frontmatter `type, title, summary (required), tags, refs, status`, then the truth, then `---`, then a dated timeline.
- Table `memory_outbox(id, op write|log, path, args JSON, createdAt, syncedAt, error)`; args are the literal `cg_write`/`cg_log` arguments.
- Tools `memory.write {scope, type, title, summary, truth, tags?, refs?}`, `memory.log {path, entry}`, `memory.list {project?, type?}`.
**Acceptance:** a write without a summary is refused; a log entry appends newest-first below the rule; outbox rows match the `cg_write` schema (snapshot copied from CG `mcp/tools/write.ts`). **Size** S (~90). **Lane** codex luna:medium. **Deps** B0.

## D1b — Common Ground sync
**Scope:** a tick, only when `memory.cg.enabled`.
- Connect with the MCP SDK `Client` over Streamable HTTP to `memory.cg.url`, with a bearer token from `memory.cg.keyEnv`, and replay unsynced outbox rows in order.
- On `conflict`: `cg_read`, then retry with `expectedSha` for Helm-owned pages (scorecards). Lessons use `cg_log` only.
- A near-duplicate refusal sets `error='duplicate'` and emits an event for the retro skill.
**Acceptance (fake MCP server):** ordered, idempotent replay; the key never appears in logs; disabled → no network. **Size** S (~90). **Lane** codex luna:high. **Deps** D1a.

## D2 — Scorecard export (mechanical)
**Scope:** new `src/scorecard.ts`: pure SQL over `workers, events, gates, prs, spend, jev_calls, reviews, claims_checks, retries, baselines, merge_queue, deploys, taps, worker_meta` and the A9 budgets. The window is the A9 sprint (`budgetId`) or `since`.
- Per project:
  - tickets (issue), merged
  - first-pass gate rate, claims pass rate, first-review approval rate, retries per ticket by kind
  - active minutes (turn.start→turn.end), Codex tokens, USD, Jev calls and cost
  - deploys and rollbacks, taps
- The **model × complexity band** table of clean/rework/failed, using the spike definitions.
- Tool `scorecard.export {project, budgetId?, since?}` returns markdown plus JSON and writes `memory.write(type:'scorecard')`. CLI `helm scorecard <project> [--json]`.
- A consumer on A9 `budget.closed` exports automatically.
**Acceptance:** a seeded store gives an exact snapshot; rework, failed and clean match the spike definitions; a rerun upserts the same one page. **Size** M (~150). **Lane** codex luna:high. **Deps** D1a, wave B/C tables.

## D3 — Skill `factory-retro` (`~/code/skills/factory-retro/SKILL.md`)
After each scorecard:
1. Read the scorecard, retry reasons, `disputed` reviews, `jev_calls`, and the REQUEST_CHANGES comments on merged PRs.
2. Write at most 5 lessons with `memory.write type:'lesson'` (summary = a one-line rule; truth = evidence with `gh:pr/N` refs).
3. Label outcomes with `jev.label`.
4. For each lesson that changes how agents work, spawn a Codex worker on `~/code/skills` → Claude review → `review.record`. The merge is `skill.merge`, which is tap-only.
**Lane** supervisor-written. **Deps** D2, B2.

## D4 — Jev skill/lesson selection for worker prompts
**Scope:** new `src/select.ts`.
- Catalog: the `select.skillAllow` skills from `skillDirs` (frontmatter name plus description, ≤350 chars) plus active lessons from the mirror (summary lines).
- At spawn when `spawnInput.skills` is absent, one Jev call:
  - `skill_or_none` (choice): "Which skill should be loaded for this task? Choose "none" if the task is routine and no skill specifically covers it." The `none` criterion: "no skill fits; a plain edit, command or routine change".
  - `lesson_or_none`: the same form.
- At confidence ≥ `autoAt` (0.7), inline the skill body (≤8k chars) and the lesson truth (≤1.5k) into the builder prompt under "Guidance selected for this task". Lessons stay shadow until labelled. Below 0.7, record `select.suggested`.
- `spawnInput.skills?: string[] | ['none']` (contract) overrides the selection.
- Store the selection in `worker_meta.skills`. The call runs outside the spawn lock.
**Acceptance (fake jev):** 0.72 → inlined; 0.65 → suggestion only; `none` → nothing; an explicit `['none']` → no call. **Size** S (~110). **Lane** codex luna:medium. **Deps** D1a, A1.

## D5 — Routing when no model is given
**Scope:** new `src/route.ts`, registered via `helm.chooseModel`. It runs only when both `model` and `difficulty` are absent.
- One Jev call on objective plus acceptance: `complexity` (score) and `too_big` (noul), using B2's wording.
- Bands: <0.75 trivial, <1.5 small, <2.25 medium, else large.
- Default `routing.tiers`: Jev's five tiers select the first available candidate in order; Codex-only policy maps tiers 1-5 to Luna medium, Luna high, Terra high, Sol medium, and Astra high, with Sol high as the tier-5 fallback.
- Scorecard rule: if D2's clean rate for (model, band) over the last 30 days is below `minClean` with n ≥ `minN`, step up to `luna:high`.
- Anything outside `routing.allowed` (luna medium or high) is clamped.
- `too_big` ≥ 0.5 → the spawn proceeds with the warning "split recommended".
- Store the band and score in `worker_meta`. No key → `luna:high`.
**Acceptance:** score 2.4 → `luna:high`; medium with clean 0.4 at n=9 → `luna:high`; a table entry outside `allowed` is clamped; an explicit model → no call. **Size** S (~90). **Lane** codex luna:high. **Deps** D2, A1.

## D6 — Supervisor skill: memory
Startup read order reads CG `projects/<name>/` through the mirror (`memory.list` until CG is live). After each sprint: scorecard → retro → delivery deck. **Lane** supervisor-written. **Deps** D3.

## Wave D live verification
1. Close a sandbox sprint: the scorecard page appears in the mirror, and its numbers match a hand count for 3 tickets.
2. The retro writes 1 lesson and opens 1 skill PR, which waits on a tap.
3. Spawn two tickets with no model: `worker_meta` shows the band and model, and there is one `select` event.
4. After go-live, flip `memory.cg.enabled`: the outbox drains and `cg_map` shows the scorecard and the lesson.
**NEEDS-NICK (last):** CG go-live §5 (empty private repo, install, handle, mint key) and `CG_API_KEY` in `~/.config/helm/env`; a CG project `<repo-name>` per project; the `select.skillAllow` list; gates `helm.json` in the skills repo.
