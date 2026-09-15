# Wave 3: reuse the completed CLI and dogfood the connected control plane

The human has unlocked predecessor reuse and asked that existing and newly built Helm capabilities be used during development. This revises the earlier host-first plan: inspect and reuse proven mechanics before rebuilding them. It is a build sequence, not a fixed workflow that Helm imposes on future orchestrators.

## Three lanes

1. **Terra: selective deterministic reuse.** Import the GitHub tracker/issue relationships and exact-evidence gate/integration behaviours from the pinned M1 source, carrying behavioural regression tests and provenance. Adapt the Map selector instead of requiring the entire Helm 3 Map to adopt legacy labels. Reconcile the predecessor's review-provenance requirements with Helm 3 attempt identities. Extract only needed modules; do not embed the old runtime wholesale.
2. **Terra: connect the runtime.** Bind the existing Fable/Astra tools to Helm 3 command records, ownership epochs, autonomy/resource limits, journal and recovery bundle. Connect Pi workers and the initial event-driven supervisor/reconciler. Reuse tested worktree/accounting/handoff mechanics where the source audit supports it. M1 did not implement the predecessor supervisor; this remains new work.
3. **Luna/Terra: make dogfooding inspectable.** Expose shared status/API/CLI projections and a thin cockpit, including source provenance, operator decisions and evidence. Reuse output/envelope and model-economy behaviours after mapping their semantics. Keep configuration pool examples separate from live quota observations; retain unknown values.

## Practical dogfood ladder

- **Now:** invoke the pinned CLI for useful deterministic tracker operations, using `docs/dogfood/helm.toml`, explicit repository and exact receipts. `frontier` currently returns an empty result because its hard-coded legacy task label does not match this Map; it is not a complete frontier observation for Helm 3. Do not route work using that result until the adapter is corrected.
- **During import:** use the accepted tracker adapter for our next issue/brief and record evidence. Run deterministic gates on actual wave PRs. Keep new and legacy ledgers separate; never invent historical attempts for agents run through this conversation.
- **During host wiring:** use Helm 3 to launch/recover a local Pi fixture attempt and inspect its journal through the shared API. Repeat against a live subscription only after OAuth and recorded live bounds are established.
- **During quality integration:** use accepted Helm 3 checks, independent-review provenance and merge mechanics on a real Helm 3 PR. A refusal is evidence to fix/adapt the seam, not a reason to use `--force` or forge an approval.

No fixed review roster or old per-ticket supervisor graph is imported. Herdr and provider subprocess adapters may remain external development aids where separately established; Pi remains Helm 3's worker runtime. Do not infer legacy worker dispatch safety from a successful tracker call, especially while the predecessor writer-lease and zero-paid-call issues remain unresolved.

## Wave exit evidence

A local run can start with either driver fixture, dispatch a native Pi fixture worker, produce command/attempt/raw evidence, expose matching CLI/cockpit state, and recover after interruption without duplicate effects. Stale epochs and expired spending authority refuse. The wave also contains a real tracker/gate dogfood receipt and source-to-import/test provenance. Live model access, full interchange, consultation/failover, full quality-loop acceptance and legacy retirement remain separately evidenced outcomes.

## Dependency changes

- HANDOFF #3 becomes a recorded receipt, not a waiting dependency; IMPORT #22 is actionable.
- Tracker #15, economy #8, workspace #10, quality #19, integration #20 and clients #21 must first check the reuse inventory in `predecessor-m1.md`.
- Ownership #28, driver #27, Fable #16 and Astra #29 still need real host wiring; API fixtures alone do not close them.
- Supervisor #17 remains new implementation. Context #13, consultation #30, interchange #32 and failover #33 follow their prerequisites.
- OAuth/live ACCESS #5 is still deferred. Baseline availability does not grant account changes or incremental paid fallback.

## Operator commands

With Node 22.22.2 on PATH, and a source checkout verified at the pinned M1 SHA:

```sh
/path/to/pinned/helm-cli/bin/helm frontier --repo /path/to/helm3/docs/dogfood --json
```

The checked-in profile has no models/adapters, no probe allowance, and an unusable gate; it is for coordinator tracker work, not a dispatch configuration or permission sandbox. The target repo is explicitly `Nicegarrry/helm3`. Never run `init --force` over another project's configuration to dogfood.
