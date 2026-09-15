# Helm 3

A durable control plane for autonomous software development.

Status: Wave 3 provider-free foundations are merged. The connected Astra/Fable fixture demo is recorded at exact head `fa049ee6ad3497312bb49a268dbe7c4364a9b1c9`; PR #59 is merged. The accepted work covers bounded tracker observation, exact-head gate evidence, durable host ownership/recovery, native Pi fixture execution, lifecycle projection, and a shared operator API/CLI view. Live Pi OAuth, provider model access, autonomous supervision and the full quality loop remain open; see [Wave 3 progress](docs/wave3-progress.md).

Helm 3 preserves the original Brief and addendum. GitHub remains authoritative for the Map and PR state. The predecessor reuse baseline is explicitly pinned at [`Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`](docs/predecessor-m1.md); selected behaviours are being adapted behind Helm 3 authority and Pi-native boundaries rather than importing the old runtime wholesale.

## Start here

- [Brief](docs/brief.md), [original human design](docs/design-source.md), and [addendum](docs/design-addendum.md)
- [Live Map](https://github.com/Nicegarrry/helm3/issues/1), [build approval](https://github.com/Nicegarrry/helm3/issues/2), and [predecessor handoff](https://github.com/Nicegarrry/helm3/issues/3)
- [Wave 3 progress](docs/wave3-progress.md), [Wave 3 dogfood evidence](docs/wave3-dogfood-evidence.md), and [Wave 4 proposal](docs/wave4-plan.md)
- [Proposed build plan](docs/build-plan.md), [Map snapshot](docs/map.md), and [39-section coverage](docs/coverage.md)
- [Control-plane contracts](docs/contracts.md) and [minimum protocol](docs/protocol.md)
- [Full acceptance protocol](docs/acceptance.md) and [migration handoff requirements](docs/migration-handoff.md)
- [SDK feasibility and remaining live-access gaps](docs/sdk-feasibility.md)
- [Operator preparation runbook](docs/operator-runbook.md) and [worker brief template](docs/worker-brief-template.md)

## Validate the current foundation

```sh
python3 scripts/check-preparation.py
npm ci --ignore-scripts
npm run typecheck
npm test
```

The Python check verifies original design provenance, Map dependencies and local document links. The npm commands validate the root contracts, kernel, journal, native Pi, workspace, tracker, host, operator and integration tests on Node 22.22.2. SDK and provider-free fixture checks are separate evidence; they do not grant OAuth or prove live provider access.

## Local fixture view

The fixture-backed operator view reads a durable host snapshot through the same read-only JSON API used by the local cockpit:

```sh
# Start the provider-free Astra fixture server with a fresh empty state directory.
node --import tsx src/dogfood/observe.ts --orchestrator astra --state-directory /tmp/helm3-demo-state --serve

# In another terminal, read the same loopback snapshot as JSON.
node --import tsx src/operator/cli.ts --url http://127.0.0.1:PORT --json
```

Use a fresh empty state directory and the explicit loopback port printed by the server. The CLI does not open the authority database or dispatch workers. The human-readable formatter and JSON output consume the same snapshot; remote origins, redirects and oversized responses are refused. The frozen demo receipt records three faux model requests, one workspace write, a succeeded command, lease-specific expiry refusal and scoped recovery evidence. PR #59 is merged.

## Accepted Wave 3 work

- [PR #52](https://github.com/Nicegarrry/helm3/pull/52): read-only operator projection, API and cockpit foundation.
- [PR #53](https://github.com/Nicegarrry/helm3/pull/53): bounded local gate/CI classification and exact evidence.
- [PR #54](https://github.com/Nicegarrry/helm3/pull/54): native GitHub Map observation and bounded transport.
- [PR #55](https://github.com/Nicegarrry/helm3/pull/55): durable host binding, ownership fencing and scoped recovery.
- [PR #56](https://github.com/Nicegarrry/helm3/pull/56): connected dogfood adapter and shared CLI/API projection.
- [PR #58](https://github.com/Nicegarrry/helm3/pull/58): authoritative attempt lifecycle projection.
- [PR #59](https://github.com/Nicegarrry/helm3/pull/59): connected Fable/Astra fixture demo, merged at exact head `fa049ee6ad3497312bb49a268dbe7c4364a9b1c9` (merge commit `43b14e14608b2b8bfde159553f10808840cbfcb9`).
- [PR #57](https://github.com/Nicegarrry/helm3/pull/57): merged Wave 4 proposal; it is planning evidence, not implementation authority.

All accepted local test counts, exact review heads and provider-free limitations are recorded in [Wave 3 progress](docs/wave3-progress.md) and the linked evidence documents.

The GitHub repository is private. Product changes use isolated worktrees and PRs; read [AGENTS.md](AGENTS.md) before starting.
