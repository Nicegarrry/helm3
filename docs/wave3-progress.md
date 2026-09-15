# Wave 3 progress

Snapshot: 2026-09-15. This page records evidence and open outcomes; it does not grant OAuth, spending, merge or unattended-run authority. The original Brief and addendum remain authoritative, and GitHub remains the Map source of truth.

## Accepted implementation and review receipts

The following Wave 3 PRs are merged and independently reviewed at their recorded heads:

- [PR #52](https://github.com/Nicegarrry/helm3/pull/52): operator projection/API/cockpit foundation; reviewed at `21251110f893d68419230d5817615c76cbc6bf43`, 65-test run and browser inspection recorded.
- [PR #53](https://github.com/Nicegarrry/helm3/pull/53): local gate and CI classification; reviewed at `67a66fcd56e667839a21471383459d20a2acfe52` and merged as `9095ee1cc2ad03252059a508e30a67aab858bd67`.
- [PR #54](https://github.com/Nicegarrry/helm3/pull/54): native GitHub Map observation, literal REST handling, bounds and termination; reviewed at `1f57586e85e0018861c4cf17e2665ae9bb5c6d2a` and merged as `397e4fc6e884855d028eed1bbde430ddeeb4edec`.
- [PR #55](https://github.com/Nicegarrry/helm3/pull/55): durable host ownership, scoped artifacts, Pi result classification and run-scoped recovery; final reviewed head `9d9d63cf4c8d91ae1496c4008c9f03c993cd4af8`.
- [PR #56](https://github.com/Nicegarrry/helm3/pull/56): connected host source, loopback CLI and shared projection; final reviewed head `8f9806e41d2be9ba44b1d22f9269c6fadfeada56`.
- [PR #58](https://github.com/Nicegarrry/helm3/pull/58): read-only attempt lifecycle projection; final reviewed head `5410b59`.

The merged connected line currently has 91 provider-free/local tests in the independent lifecycle review. These tests establish contracts, fixtures and local runtime boundaries; they are not live-provider or full-autonomy acceptance.

## What the local foundation proves

The accepted slices provide bounded tracker reads, exact-head local gate evidence, durable command/attempt/artifact state, one-owner epoch fencing, scoped restart recovery, native Pi fixture execution, lifecycle observations, and a read-only operator API/CLI projection. The CLI and cockpit consume the same public snapshot. Run-local reservations remain separate from provider quota, and unknown quota/headroom stays unknown.

The reusable predecessor baseline is [`Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`](predecessor-m1.md). Reuse is authorised, but selected behaviours remain adapted imports; the old runtime and supervisor workflow are not Helm 3 authority.

## Demo status

**Review pending:** the final Astra fixture demo receipt, observed API/cockpit capture and exact run head are awaiting independent review. Do not treat this placeholder as a completion claim. Once root records the frozen receipt, replace this paragraph with the exact SHA, request/effect counts, authority-expiry observation, receipt path/hash and the loopback CLI/HTML entry used for the same snapshot.

The intended provider-free smoke path is:

```sh
npx tsx src/operator/cli.ts --url http://127.0.0.1:PORT --json
```

The local server/demo supplies the ephemeral loopback port. The CLI is read-only, refuses remote origins and bounded response violations, and shares the API snapshot consumed by the cockpit. An optional `--serve` command remains review-pending until its final implementation and receipt are frozen.

## Remaining outcomes

Live OAuth and provider model access remain open under the explicit human-availability boundary. The following are also unbuilt or only locally bounded: the native event supervisor with coalesced wakes and lease-bounded retries; model-economy facts, reserves and live quota observations; fresh GitHub Map mutation; the complete gate → independent review → repair → exact-head integration loop; Fable/Astra live interchange; consultation; context/compaction; cross-provider failover; calibration; full feature acceptance; and legacy retirement.

[PR #57](https://github.com/Nicegarrry/helm3/pull/57) proposes the next sequencing for those outcomes. It is a draft planning document, not an implementation or authority grant. OAuth/live access may proceed in parallel only when the human is available and gives explicit bounded consent; no baseline credential, fixture success or elapsed time grants consent automatically.

See [Wave 3 dogfood evidence](wave3-dogfood-evidence.md), [host evidence](host-evidence.md), [operator evidence](operator-evidence.md), [tracker import evidence](tracker-import-evidence.md), [gate evidence](gate-evidence.md), and the [Wave 4 proposal](wave4-plan.md) for detailed boundaries and receipts.
