# First-wave contract freeze

Status: frozen for the first implementation wave on 2026-09-15. This document
freezes shared TypeScript names and validation boundaries, not the full Helm
runtime or a provider integration.

The source Brief remains authoritative. This freeze covers the common seams
needed to start independent kernel work: immutable command envelopes and their
fresh-observation preconditions; Autonomy and Orchestrator leases; durable
events and historical attempts; typed worker claims and gate observations; raw
artifact references; and the small replaceable `OrchestratorDriver` interface.

`src/contracts/index.ts` is the executable source for the frozen names. The
generic `commandSchema` validates only the durable envelope. It deliberately
does not certify `payload` for effect execution. An executor must call
`parseExecutableCommand` with the command-kind registry at its trusted boundary
and then separately re-read authority, ownership, expiry and external
preconditions before an effect. An authenticated runtime resolves actor
identity; parsing model-supplied payload never authenticates `actorId` or grants
authority.

The `origin: 'orchestrator'` discriminator requires an ownership lease reference
and a positive epoch. Other origins structurally reject those controller fields.
The schemas validate nonempty opaque IDs, UTC RFC3339 timestamps, and finite
non-negative resource limits. They do not implement compare-and-swap ownership,
claims, reservation, journaling, execution, reconciliation, worker containment,
or provider SDK behavior.

`Attempt` records the prescribed historical snapshot shape. This wave does not
make it persistent or enforce its immutability; storage and mutation policy are
the kernel lane's responsibility. `WorkerResult` remains a claim manifest and
`GateResult` records observation/evidence: neither makes a claim true.

The driver has no embedded authority. Starting a driver session does not grant a
controller epoch, and no Fable/Astra SDK is assumed to implement the interface
natively. The contract intentionally preserves Pi as the single worker runtime
and avoids a generic worker or workflow abstraction.

The accompanying SDK feasibility evidence may support provider-specific control
mappings for starting/resuming sessions and cancellation requests. It does not
upgrade this interface into a live-access claim: checkpoint and handoff are
Helm-owned, and interruption/stop retain `pending` and `unknown` outcomes.

Source hashes retained without modification:

- `docs/design-original.md`: `d203c57e88842b1413f9f8c20c10ac09c38da83a5e04eb70a12511f09bbcf337`
- `docs/design-addendum.md`: `2804ec1cbfc91f1accd2e800fc60da560c449b811628b6daf82c234c8e69d5f9`
