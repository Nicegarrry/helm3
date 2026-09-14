# Helm 3

A durable control plane for autonomous software development.

Status: first-wave foundation in progress (2026-09-15). The human approval is recorded; the live ACCESS check remains open and the kernel/raw-artifact work is still in progress.

This repository is independent of `Nicegarrry/helm-cli` while Opus completes Milestone 1 there. No source, tests, credentials, or working state have been imported from that repository. A later, SHA-pinned handoff will supply reusable behaviours and implementation.

## Start here

- [Brief](docs/brief.md), [original human design](docs/design-source.md), and [addendum](docs/design-addendum.md)
- [Live Map](https://github.com/Nicegarrry/helm3/issues/1), [build approval](https://github.com/Nicegarrry/helm3/issues/2), and [predecessor handoff](https://github.com/Nicegarrry/helm3/issues/3)
- [Proposed build plan](docs/build-plan.md), [Map snapshot](docs/map.md), and [39-section coverage](docs/coverage.md)
- [Control-plane contracts](docs/contracts.md) and [minimum protocol](docs/protocol.md)
- [Full acceptance protocol](docs/acceptance.md) and [migration handoff requirements](docs/migration-handoff.md)
- [SDK feasibility and remaining live-access gaps](docs/sdk-feasibility.md)
- [Current first-wave progress](docs/wave1-progress.md)
- [Operator preparation runbook](docs/operator-runbook.md) and [worker brief template](docs/worker-brief-template.md)

## Validate the current foundation

```sh
python3 scripts/check-preparation.py
npm ci --ignore-scripts
npm run typecheck
npm test
```

The Python check verifies original design provenance, Map dependencies and local document links. The npm commands validate the merged root contract schemas and tests on Node 22.22.2. SDK feasibility probes are separate provider-free evidence; no complete product CLI, service, autonomous supervisor, live provider route, failover, or worker fabric is shipped.

The GitHub repository is private. First-wave approval is recorded in [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2#issuecomment-5671903235), and merged foundation work is tracked in [PR #36](https://github.com/Nicegarrry/helm3/pull/36), [PR #37](https://github.com/Nicegarrry/helm3/pull/37), and [PR #38](https://github.com/Nicegarrry/helm3/pull/38). Product changes use isolated worktrees and PRs; read [AGENTS.md](AGENTS.md) before starting.
