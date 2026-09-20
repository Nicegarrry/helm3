# Local handoff: prove Helm live, merge PR #138, retire the old control plane

Audience: a coding agent (Claude Code or Codex) running on the owner's machine with Pi
installed, Pi provider logins, and `gh` authenticated. Date: 2026-09-20.

Everything in this file is authorised by the owner. Where it says "ask", stop and ask the
owner in chat; do not guess. Where it says "never", there is no override.

---

## 0. State you are inheriting

- Branch `claude/helm3-assessment-simplify-qsdefo`, draft PR #138 against `main`.
- New package `helm/`: 12 source files, 95 tests, typecheck clean, CI green on the branch.
  Read `helm/README.md` first, then `helm/evidence/report.md` and `helm/evidence/log.md`.
- Proven with Pi's faux provider only: the full loop (spawn, worktree, gate, push, PR open),
  restart and resume, MCP over stdio and HTTP, the dashboard. Not yet proven: a real model
  and a real GitHub PR. `src/github.ts` has never run against a real `gh`.
- The old control plane in `src/`, `test/` and `docs/` is untouched and still passes its own
  383 tests. It is legacy.

Standing rules from the owner: no purchases, top-ups or account changes; any ChatGPT worker
must be Luna, and prefer open models; credentials never enter the repo, a config file or a
log; free routes only ever see synthetic content; keep `helm/` under 3k source lines.

## 1. Preflight (ask the owner for anything blank)

| Need | Value |
| --- | --- |
| Target repo for the live proof, small, PRs welcome, not helm3 itself | `__________` |
| Hard spend cap for this whole task, USD | `__________` |
| Builder model as Pi names it, e.g. `opencode-go/qwen3.8-flash` | `__________` |
| Reviewer model from a different family, e.g. `google/gemini-3.8-flash` | `__________` |
| Free smoke model, e.g. `openrouter/nvidia/nemotron-3-ultra-550b-a55b-20260604:free` | `__________` |

Then, from the repo root:

```sh
git fetch origin && git checkout claude/helm3-assessment-simplify-qsdefo && git pull
node --version                      # 22.x
cd helm && ln -sfn ../node_modules node_modules && npm test && cd ..
pi login                            # confirm the providers above are logged in
gh auth status
```

Do not proceed until `npm test` in `helm/` is green on this machine.

## 2. Wave A live proof: the loop closes

1. Start the daemon in its own terminal and keep it running:
   `HELM_SPEND_CAP_USD=<cap> HELM_HOME=~/.helm ./helm/bin/helm.js serve --http --port 4747`
   Open `http://127.0.0.1:4747/` in a browser and leave it open.
2. Smoke on the free model with a synthetic task in a scratch repo you create locally
   (`git init` a temp dir with a README and a `helm.json` gate such as `test -f hello.txt`):
   `helm spawn --repo <scratch> --objective "Create hello.txt containing a greeting" --model <free>`
   then `helm logs <id> -f`, `helm gate <id>`. Expect: tool calls in the log, a commit, a
   passing gate. This never touches private code.
3. Real task on the target repo with the builder model. Pick something small and useful,
   for example a missing test or a flag. `helm spawn`, watch, `helm gate`, `helm pr`.
   Expect a real draft PR on GitHub with a green gate recorded at its head.
4. If `helm pr` or `helm pr-status` fails, the fault is almost certainly in
   `helm/src/github.ts` (URL parsing of `gh pr create`, or `gh pr view --json` field shapes).
   Fix it there, add or adjust the fake-exec test in `helm/test/github.test.ts`, rerun.
   Do not work around it by calling `gh` by hand.
5. Record in `helm/evidence/live.md`: date, machine, models, every command, tokens and cost
   from `helm status` and `helm inspect`, the PR URL, and any fix you made.

## 3. Wave B live proof: durable and cheap

1. `helm review <id> --model <reviewer>`: expect a review worker, then a verdict comment on
   the PR from step 2.3. If Helm refuses because of the model family rule, choose another
   family; do not pass `allowSameFamily`.
2. Spawn another task, then kill the daemon (Ctrl-C) while the worker is running. Restart
   it. `helm ps` must show that worker as `interrupted`. `helm steer <id> "Continue and
   finish."` must resume the same Pi session to a result.
3. Set `HELM_SPEND_WARN_USD` low enough to cross and confirm the amber bar, the
   `spend.warning` event and the `warning` field on a spawn result. Then set
   `HELM_SPEND_CAP_USD` below current spend and confirm a spawn is refused.
4. Append all of it to `helm/evidence/live.md`.

## 4. Wave C live proof: watchable

Run three workers at once on the target repo with `HELM_MAX_WORKERS=3`. Screenshot the
dashboard with all three running and save it as `helm/evidence/live-dashboard.png`.

## 5. Orchestrator through MCP

Add `helm/.mcp.example.json` to the target repo's `.mcp.json` with the real path and
`"args": ["serve", "--stdio", "--port", "4747"]`. Start a fresh Claude Code session in the
target repo and give it one task in plain English, telling it to use only the `helm` tools to
do the work. It should spawn, poll, gate, open the PR and request a review without you
touching Helm. Paste the tool-call sequence into `helm/evidence/live.md`. If Codex is the
orchestrator instead, point it at `http://127.0.0.1:4747/mcp`.

## 6. Merge

1. Update `helm/evidence/report.md` section 1 so each exit proof says what was proven live,
   with links into `live.md`. Update section 4 gaps.
2. `cd helm && npm test && npx tsc --noEmit`, then commit and push to the same branch.
3. Wait for CI on the final head to be green (`gh pr checks 138 --watch`).
4. Mark PR #138 ready for review: `gh pr ready 138`.
5. Merge with a merge commit, which is this repo's convention:
   `gh pr merge 138 --merge --delete-branch`. Never force-push, never rebase the branch.

## 7. After the merge, in a second PR

1. Tag the pre-merge state so the old control plane stays reachable:
   `git tag legacy-control-plane <sha of main before the merge> && git push origin legacy-control-plane`.
2. Replace the root `AGENTS.md` with the draft in `helm/evidence/report.md` section 6.
3. Replace the root `README.md` body with a short pointer to `helm/README.md`, keeping one
   paragraph that names the tag for the legacy build.
4. Move `docs/one-shot-brief.md` and this file under `helm/docs/`.
5. Ask the owner before deleting `src/`, `test/`, the old `docs/` and the old CI jobs. If
   they say yes, delete them in this same PR and remove the `contracts-and-core` and
   `preparation` CI jobs. If they say no, leave them.
6. Open the PR, wait for green CI, merge it the same way.

## 8. Issues

Close as completed with a one-line comment pointing at `helm/README.md`: #8, #10, #11, #27.
Open one issue titled "Deferred control-plane design" that lists #5, #9, #13, #14, #16, #18,
#22, #24, #29, #30, #32, #33, #113, #117, #119, #120, #121, #130 and says they are parked
until the harness has been used in anger. Do not close those. Leave #23, #25, #111, #112,
#114, #115, #116, #118, #126 open with a comment saying which Helm tool now covers each.

## 9. Stop conditions and report

Stop and ask if: a live step fails twice for the same reason; spend passes half the cap
before section 3 is done; a provider returns 429 or a billing error; anything wants an
account or plan change. Never delete a worktree with uncommitted work.

Finish with a message to the owner containing: PR URLs, total spend by model, what was
proven live, what was not, and anything you changed in `helm/src/` with the reason.
