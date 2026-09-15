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

The connected demo line has 95 provider-free/local tests at the final review head. These tests establish contracts, fixtures and local runtime boundaries; they are not live-provider or full-autonomy acceptance.

## What the local foundation proves

The accepted slices provide bounded tracker reads, exact-head local gate evidence, durable command/attempt/artifact state, one-owner epoch fencing, scoped restart recovery, native Pi fixture execution, lifecycle observations, and a read-only operator API/CLI projection. The CLI and cockpit consume the same public snapshot. Run-local reservations remain separate from provider quota, and unknown quota/headroom stays unknown.

The reusable predecessor baseline is [`Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`](predecessor-m1.md). Reuse is authorised, but selected behaviours remain adapted imports; the old runtime and supervisor workflow are not Helm 3 authority.

## Demo status

The final provider-free fixture demo is recorded at exact PR #59 head `fa049ee6ad3497312bb49a268dbe7c4364a9b1c9`; PR #59 is merged. The automated suite covers both Fable and Astra fixture paths and records 95 passing tests at the final review head. The manual Astra receipt exercised three faux model requests, one `pi.write`, a succeeded command, lease-specific expiry refusal, normal lifecycle stop with `outcome: null`, and a nested Pi write process kill whose effect became unknown and whose replay was refused.

The merged demo review receipt is [PR #59 comment](https://github.com/Nicegarrry/helm3/pull/59#issuecomment-5677503376). The raw Astra receipt is `/Volumes/T7/webdev-factory/worktrees/helm3/final-astra-receipt.json`. Its recovery bundle raw reference is `sha256:e8ab21fd5f3273fe92584e634a1c313c449a4460615fc090533d5166730d49df`. The retained fixture state is `/Volumes/T7/webdev-factory/worktrees/helm3/final-astra-fa049ee`. The final operator snapshot is recorded at `/Volumes/T7/webdev-factory/worktrees/helm3/final-operator-snapshot.json`; the snapshot and cockpit use the same loopback API projection. The verification endpoint was `http://127.0.0.1:60397/api/operator/snapshot` and was stopped after inspection; a fresh-state endpoint should be used for any rerun. The inspected browser/API projection showed a stopped attempt with `outcome: null`, expired autonomy, active Astra ownership, three fixture requests, zero outstanding reservations, and explicit unknown live quota, context and Map values.

The executable local CLI path is:

```sh
# Start the provider-free Astra fixture server with a fresh empty state directory.
node --import tsx src/dogfood/observe.ts --orchestrator astra --state-directory /tmp/helm3-demo-state --serve

# In another terminal, read the same loopback snapshot as JSON.
node --import tsx src/operator/cli.ts --url http://127.0.0.1:PORT --json
```

Use the ephemeral port printed by the server. The CLI is read-only, refuses remote origins and bounded response violations, and shares the API snapshot consumed by the cockpit. This is provider-free fixture evidence; PR #59 is merged at the recorded exact head.

## Remaining outcomes

Live OAuth and provider model access remain open under the explicit human-availability boundary. The following are also unbuilt or only locally bounded: the native event supervisor with coalesced wakes and lease-bounded retries; model-economy facts, reserves and live quota observations; fresh GitHub Map mutation; the complete gate → independent review → repair → exact-head integration loop; Fable/Astra live interchange; consultation; context/compaction; cross-provider failover; calibration; full feature acceptance; and legacy retirement.

[PR #57](https://github.com/Nicegarrry/helm3/pull/57) is the merged Wave 4 sequencing proposal, not an implementation or authority grant. OAuth/live access may proceed in parallel only when the human is available and gives explicit bounded consent; no baseline credential, fixture success or elapsed time grants consent automatically.

See [Wave 3 dogfood evidence](wave3-dogfood-evidence.md), [host evidence](host-evidence.md), [operator evidence](operator-evidence.md), [tracker import evidence](tracker-import-evidence.md), [gate evidence](gate-evidence.md), and the [Wave 4 proposal](wave4-plan.md) for detailed boundaries and receipts.
