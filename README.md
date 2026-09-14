# Helm 3

Preparation repository for a durable control plane for autonomous software development.

Status: foundation and feasibility preparation only. Product implementation awaits explicit human approval.

This repository is independent of `Nicegarrry/helm-cli` while Opus completes Milestone 1 there. No source, tests, credentials, or working state have been imported from that repository. A later, SHA-pinned handoff will supply reusable behaviours and implementation.

## Start here

- [Brief](docs/brief.md), [original human design](docs/design-source.md), and [addendum](docs/design-addendum.md)
- [Live Map](https://github.com/Nicegarrry/helm3/issues/1), [build approval](https://github.com/Nicegarrry/helm3/issues/2), and [predecessor handoff](https://github.com/Nicegarrry/helm3/issues/3)
- [Proposed build plan](docs/build-plan.md), [Map snapshot](docs/map.md), and [39-section coverage](docs/coverage.md)
- [Control-plane contracts](docs/contracts.md) and [minimum protocol](docs/protocol.md)
- [Full acceptance protocol](docs/acceptance.md) and [migration handoff requirements](docs/migration-handoff.md)
- [SDK feasibility and remaining live-access gaps](docs/sdk-feasibility.md)
- [Operator preparation runbook](docs/operator-runbook.md) and [worker brief template](docs/worker-brief-template.md)

## Validate preparation

```sh
python3 scripts/check-preparation.py
```

This verifies original design provenance, Map dependencies and local document links. SDK feasibility probes are separate throwaway artifacts; no product CLI, service or autonomous supervisor is shipped by this preparation.

The GitHub repository is private. The root bootstrap contains documents and preparation tooling only. This revised approach returns for CONTEXT CLEAN, then requires explicit approval before the first implementation wave. Product changes use isolated worktrees and PRs after that approval; read [AGENTS.md](AGENTS.md) before starting.
