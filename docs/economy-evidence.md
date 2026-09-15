# Wave 4 model economy evidence

## Scope and authority

This provider-free slice implements the model-fact and dispatch-eligibility portion of issue #8. It does not call a provider, read credentials, infer a quota from an account, route work, or create a second budget ledger.

`src/economy` records compact registry facts, distinct subscription/API/top-up pools, and quota observations. A missing, unavailable, or explicitly unknown provider reading is represented as unknown; it is never converted into remaining capacity, cost, or reset time.

## Core binding

`toCoreModelFact` projects a registry profile into Core's existing `ModelFact` contract. A privileged host wires the returned fact through `KernelHost.putModelFact`; Core's existing `KernelKind.modelSelection` and transactional resource reservation paths remain the final dispatch and reserve gates.

`DispatchAuthority` is the explicit economy-to-Core seam. It accepts Core's `ResourceRequest` verbatim and does not expose a mutable economy ledger. The module checks model/pool/unit consistency before requesting that authority. The authority owns leases, accumulated reservations, actual settlement, human reserve exceptions, and the active-orchestrator reserve.

An opaque `humanOverrideId` inside an ordinary eligibility request is refused as unattested and is never forwarded. Only a privileged host can attest a human exception directly to Core, so the active orchestrator cannot waive its own reserve.

## Refusal and evidence matrix

| Condition | Economy result | Final authority |
| --- | --- | --- |
| Disabled model | `disabled_model` | Core rejects the matching model fact |
| Unknown/unavailable model | `availability_unknown` / `availability` | Core requires `known_available` |
| Public-only model given restricted data | `data_policy` | Economy policy check before admission |
| Missing role/capability | `role` / `capability` | Registry check; Core receives the required capability floor |
| Wrong pool or unit | `pool_mismatch` | Core reservation contract |
| Reserve or lease limit | `authority` | Core reservation/lease ledger |
| Forged human override | `unattested_human_override` | Privileged Core host only |

The registry carries separate build and review capability arrays. `toCoreModelFact` preserves their union for Core's generic capability floor, while eligibility chooses the role-specific array before admission.

## Provenance

The behaviour is adapted from the authorised predecessor baseline `Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`: its `src/budget.ts` distinguishes native pool units and refuses manufactured budget certainty. This implementation deliberately excludes its legacy ledger, adapters, routing and provider probes because Helm 3 Core already owns durable authority and reservations.

## Verification

Run with Node `22.22.2`:

```sh
npx tsx --test test/economy/economy.test.ts
npm run typecheck
npm test
```

The economy tests cover native pool units, absent/unknown quota, disabled/policy/role/capability/unknown-availability refusal, separate build/review capabilities, Core model-fact projection, Core reservation delegation, and refusal of a forged reserve override.
