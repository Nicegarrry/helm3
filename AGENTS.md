# Helm agent contract

Helm is a harness: an orchestrator agent calls Helm tools; Helm runs Pi workers on cheap
models in isolated worktrees, runs gates, opens PRs and reports status durably. The code
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
- Product changes are PRs from worktrees. Keep `helm/` under 3k lines; cut before adding.
- Prefer open models via OpenCode or OpenRouter for builders; a different family for review.
- Run `npm test` in `helm/` before pushing.
- The pre-`helm/` control plane is retired. It is reachable at the `legacy-control-plane`
  tag and is not extended.
