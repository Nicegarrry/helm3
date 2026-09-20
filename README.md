# helm3

The harness lives in **[`helm/`](helm/)**. Start with [`helm/README.md`](helm/README.md).

Helm lets an orchestrator agent — Claude Code, Codex, or a script — dispatch coding work to
Pi workers running cheap models, each in its own git worktree, and get back gates, PRs and
status without doing the mechanics itself. Ten tools, one SQLite file, one daemon.

Proven live on 2026-09-20 against real models and a real GitHub repository:
[`helm/evidence/live.md`](helm/evidence/live.md).

## The earlier control plane

This repository previously held a much larger control plane under `src/`, `test/` and `docs/` —
about 19,900 lines and 16 SQLite tables — which `helm/` replaces with roughly 2,800 lines and
five tables. That work is not deleted, only retired: it is reachable in full at the
**`legacy-control-plane`** tag.

```sh
git show legacy-control-plane:README.md
git checkout legacy-control-plane
```

It is not extended. New work goes in `helm/`.
