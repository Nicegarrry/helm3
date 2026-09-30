# Helm agent contract

Helm is a harness: an orchestrator agent calls Helm tools; Helm runs workers in isolated
worktrees (Pi sessions on cheap API models, or the Codex CLI on the operator's ChatGPT
subscription for `codex/…` models), runs gates, opens PRs and reports status durably. The code
lives in `helm/`. Read `helm/README.md` first.

## Rules
- GitHub owns issues and PRs. Helm owns worker state in `$HELM_HOME/helm.sqlite`.
- One worker per worktree. Workers never push; `pr.open` pushes after a passing gate.
- A PR merges only when checks are green at the exact head the gate passed on.
- Spend is capped by `HELM_SPEND_CAP_USD`. Unknown prices are reported, never blocked.
- Credentials stay in Pi's own store and `gh`. Never in the repo, config or logs.
- No purchases, top-ups or account changes. Free routes see synthetic content only.
- Workers report a JSON `WorkerResult`; a model's claim is not evidence until a gate ran.

## Working method
- Product changes are PRs from worktrees. Keep `helm/src` under 11.0k lines (raised to 11.0k on 2026-09-30 by Nick after same-day capacity, routing, Claude lane, gate sandbox, hygiene and spend-cap work (10,469 at the time); counted over all .ts files under helm/src including subdirectories; raised to 8.0k on 2026-09-30 by Nick for Helm v4 waves B-D, 7,825 at merge: the Pi lane is kept, the web dashboard was removed and automatic disk hygiene added; raised to 5.3k on 2026-09-29 for Helm v4 wave B; raised from 5.0k on 2026-09-29 for wave A + A9 budgets; raised from 3.1k on
  2026-09-29 for Helm v4 wave A); cut before adding.
- Builders: the Codex lane when the operator's subscription window allows it, otherwise open
  models via OpenCode or OpenRouter; review from a different model family either way.
- Run `npm test` in `helm/` before pushing.
- The pre-`helm/` control plane is retired. It is reachable at the `legacy-control-plane`
  tag and is not extended.
