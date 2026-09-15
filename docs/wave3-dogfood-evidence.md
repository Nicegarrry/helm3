# Wave 3 dogfood evidence

This record distinguishes accepted imports, real repository observations and provider-free execution fixtures. It grants no new account or spending authority.

## Accepted selected imports

- Gate/CI behaviour: PR53 reviewed at `67a66fcd56e667839a21471383459d20a2acfe52`, merged as `9095ee1cc2ad03252059a508e30a67aab858bd67`. The five new behavioural groups cover CI classification and actual local gate effects. See [gate scope and limitations](gate-evidence.md).
- Tracker: PR54 reviewed at `1f57586e85e0018861c4cf17e2665ae9bb5c6d2a`, merged as `397e4fc6e884855d028eed1bbde430ddeeb4edec`. Eleven native tracker groups cover hierarchy/dependencies, literal REST responses, external blocker identity, bounds and termination. See [import provenance and tests](tracker-import-evidence.md).
- Thin operator surface: PR52 reviewed at `21251110f893d68419230d5817615c76cbc6bf43`, merged as `11f35fc07b08b6cbecc4594a247c9811d0b4a67a`. Independent 65-test run and browser inspection passed. This supplied the view/API; the host adapter and CLI added here connect its inputs.

All selected predecessor behaviours refer to `Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`. Full check/merge provenance, economy/workspace/handoff reuse decisions and the remaining native runtime work are still separate Map outcomes; IMPORT #22 is not wholesale closed by these slices.

## Actual GitHub Map observation

The coordinator executed the new tracker on its reviewed PR54 head:

```sh
npx tsx src/tracker/observe.ts --repo Nicegarrry/helm3 --map 1
```

At `2026-09-15T08:23:56.450Z`, it returned `complete`, 34 nodes, frontier issue numbers `5, 7, 8, 10, 15, 22`, and no incomplete reasons. The native hierarchy fixes the predecessor's hard-coded label mismatch. This is a dated projection, not a permanent frontier or action authorisation.

Local raw receipt: `/Volumes/T7/webdev-factory/worktrees/helm3/tracker-map-receipt.json`. Independent review is preserved on [PR54](https://github.com/Nicegarrry/helm3/pull/54#issuecomment-5677106673).

## Actual gate dogfood

The accepted `runGate` executed typecheck and the full 72-test suite on clean tracker head `1f57586e85e0018861c4cf17e2665ae9bb5c6d2a`. Both exited 0; expected and observed SHA matched; final state was `passed`.

Final raw evidence: `raw:sha256:e84dac1b5a8280462f4be871a7ef02e599abf092c69b55686991b2fa116b3646`.

Local journal: `/Volumes/T7/webdev-factory/worktrees/helm3/gate-dogfood-evidence`; receipt: `/Volumes/T7/webdev-factory/worktrees/helm3/gate-dogfood-receipt.json`. The coordinator invoked trusted local checks under the approved development scope. This did not exercise autonomous gate dispatch, independent-review provenance or Helm-owned merge mechanics. Those remain later quality-loop evidence.

## Shared host view

`createHostSnapshotSource` reads the durable host and optional native GitHub Map observer. It projects only public status fields; command payloads, raw transcripts and recovery content are excluded. GitHub outage leaves host state inspectable and marks the Map unavailable. A partial Map never produces a known-empty frontier.

Run-local resource reservations are distinct from provider quota. Outstanding reservations are not consumption, and unknown subscription headroom remains unknown. Revoked and expired leases retain their status. Several scoped autonomy leases are not collapsed into one globally active authority. Missing decision, quality and context producers remain explicit unknowns.

The local CLI reads the exact same loopback JSON API as the cockpit:

```sh
npx tsx src/operator/cli.ts --url http://127.0.0.1:PORT --json
```

Use the port printed by the host/demo server. This client never opens the authority database or dispatches workers. It refuses remote origins, redirects and oversized responses. The human-readable formatter omits detail; JSON retains the full public projection.
