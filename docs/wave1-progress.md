# Helm 3 first-wave progress

Status as of 2026-09-15. This is an operator entrypoint; GitHub issue and PR state remains authoritative.

## Authority and current frontier

First-wave authority is recorded in [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2#issuecomment-5671903235) and [docs/wave1-authority.md](wave1-authority.md). It authorises supervised foundation work and reviewed PR integration in this repository, with at most three workers plus coordinator. It does not authorise purchases, top-ups, incremental paid API fallback, an unattended Helm run lease, provider login changes or predecessor access.

[FREEZE #4](https://github.com/Nicegarrry/helm3/issues/4) is closed. The executable contracts and usage telemetry schemas are merged in [PR #38](https://github.com/Nicegarrry/helm3/pull/38), with Node 22.22.2 typecheck, nine contract test groups and preparation checks passing.

[ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) remains open. [PR #37](https://github.com/Nicegarrry/helm3/pull/37) provides provider-free Codex SDK 0.154.0 evidence: local start/resume/run/streaming and child exit after AbortSignal. It does not prove subscription entitlement, live Pi/Fable/Astra access, provider cancellation, quota bounds or cost.

[KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) is the active Terra implementation frontier. Raw-artifact work may proceed against the frozen reference schema, but final Log integration depends on the kernel. No complete worker fabric, autonomous run, failover, production deployment or acceptance scenario is complete.

## Verification

From the repository root on Node 22.22.2:

```sh
python3 scripts/check-preparation.py
npm ci --ignore-scripts
npm run typecheck
npm test
```

These checks cover preparation and merged contract schemas/tests. They do not establish live provider access or full system readiness.

## Orientation links

- [Authority](wave1-authority.md)
- [Frozen contracts](contract-freeze.md)
- [Protocol](protocol.md)
- [Build plan](build-plan.md)
- [Operator runbook](operator-runbook.md)
- [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5)
- [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6)
