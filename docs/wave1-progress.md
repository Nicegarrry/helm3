# Helm 3 first-wave progress

Status as of 2026-09-15. This is an operator entrypoint; GitHub issue and PR state remains authoritative.

## Authority and current frontier

First-wave authority is recorded in [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2#issuecomment-5671903235) and [docs/wave1-authority.md](wave1-authority.md). It authorises supervised foundation work and reviewed PR integration in this repository, with at most three workers plus coordinator. It does not authorise purchases, top-ups, incremental paid API fallback, an unattended Helm run lease, provider login changes or predecessor access.

[FREEZE #4](https://github.com/Nicegarrry/helm3/issues/4) is closed. The executable contracts and usage telemetry schemas are merged in [PR #38](https://github.com/Nicegarrry/helm3/pull/38), with Node 22.22.2 typecheck, nine contract test groups and preparation checks passing.

[ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) remains open. [PR #37](https://github.com/Nicegarrry/helm3/pull/37) provides provider-free Codex SDK 0.154.0 evidence: local start/resume/run/streaming and child exit after AbortSignal. It does not prove subscription entitlement, live Pi/Fable/Astra access, provider cancellation, quota bounds or cost.

[KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) is implemented in [PR #41](https://github.com/Nicegarrry/helm3/pull/41). It provides immutable commands, append-only events/attempts, trusted execution, separate ownership/autonomy checks, durable refusals and unknown-effect recovery. [PR #40](https://github.com/Nicegarrry/helm3/pull/40) implements the raw artifact journal and rebuildable SQLite index. Both passed independent Terra/Luna reviews and CI at their final heads.

The integration oracle in `test/integration/evidence-log.test.ts` combines both modules in one SQLite file: after a simulated lost acknowledgement, the effect remains unknown; raw bytes survive; rebuilding the artifact index preserves commands and human decisions; hash-verified evidence reconciles success without executing twice. The complete local suite is 28 test groups (9 contracts, 8 kernel, 10 journal, 1 integration). Node 22's SQLite module remains experimental. These are local deterministic and provider-free SDK proofs, not full runtime acceptance.

Live ACCESS remains the unresolved first-wave item. Full resource accounting/reserves/quarantine (#7), complete orchestrator-driver integration (#27/#16/#29), native Pi execution (#11/#12), and controlled failover (#33) remain later work. No complete worker fabric, unattended autonomous run, production deployment or original-plus-addendum acceptance scenario is complete. The predecessor handoff (#3) remains independent and untouched.

## Verification

From the repository root on Node 22.22.2:

```sh
python3 scripts/check-preparation.py
npm ci --ignore-scripts
npm run typecheck
npm test
```

These checks cover preparation, contracts, the deterministic kernel, raw artifacts and their shared-database integration. They do not establish live provider access or full system readiness.

## Orientation links

- [Authority](wave1-authority.md)
- [Frozen contracts](contract-freeze.md)
- [Protocol](protocol.md)
- [Build plan](build-plan.md)
- [Operator runbook](operator-runbook.md)
- [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5)
- [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6)
