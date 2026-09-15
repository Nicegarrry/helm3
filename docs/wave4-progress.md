# Wave 4 observed progress — 15 September 2026

The user approved continuing Wave 4 and onward overnight under the [recorded authority](overnight-authority.md). This is an evidence checkpoint, not full Brief acceptance. GitHub Map #1 and issue state remain authoritative.

## Accepted foundations

PR #61 records the overnight authority. PR #62 adds immutable economy facts and role/data-policy-aware Core admission. PR #63 adds fixed-route, bounded native Pi requests and validated token settlement. PR #64 adds durable supervisor signals, coalesced judgement wakes and pure recovery classification. PR #65 adds guarded fresh GitHub Map mutations. Each was independently reviewed with executable tests and green exact-head CI before coordinator integration.

Their combined main head `c5b4e24810ea9129bd40f968e20e423daa2900d6` passed `npm run typecheck` and all **123 tests** with Node 22.22.2 and a private frozen dependency installation. Individual review heads were:

| PR | Reviewed head | Independent validation |
| --- | --- | --- |
| #62 | `ac8b5f4c91e51524aba841a0f37db7080c6945d8` | 103 tests, typecheck and economy policy regression probes |
| #63 | `ce4ecb973694cce92095dd9296b600be440896ff` | Standards: 101 tests; Spec: 14 targeted tests; typecheck and adversarial configuration/usage probes |
| #64 | `3201358997d9764598330a623b58f41d2ee58375` | 100 tests, typecheck and takeover-at-acknowledgement probe |
| #65 | `3f59684a13b21d970d7b618c1b779690c1b801d5` | 104 tests, typecheck and final target revision regression |

PR #62's final head `4abc7a3c9fef2ad5e0ad0b57a2a1adac3474b4a2` only combined the already-reviewed supervisor/main changes with the economy code; the combined suite passed 108 tests and CI was green before merge.

## Real native Pi dogfood

The coordinator used the accepted `BoundedPiAccess`, `createBoundedPiWorkerBinding`, `PiNativeRuntime`, `HostControlPlane` and `WorkspaceManager` against the pinned `opencode-go/kimi-k2.7-code` route. Credentials stayed outside Git and worker context. This was an actual Pi SDK session with Helm worktree ownership, command admission, durable reservation, raw semantic events and a structured terminal envelope.

The synthetic attempt `pi-synthetic-3a6ca189-085a-44de-8d5d-7ad6e417d47e` succeeded. Its US$1.34742016 upper bound settled to US$0.0008727 using validated provider token fields and frozen nominal prices. This does not establish actual incremental subscription billing or known quota headroom.

A subsequent read-only engineering-review attempt exposed a failure-path defect: the model command became `unknown`, while the parent host process failed to finish promptly. The coordinator stopped that local process, verified its absence, revoked the attempt lease and used host restart recovery. The model effect and attempt remain `unknown`; the full US$1.34742016 reservation remains charged to the guard. It has not been replayed. The resulting combined committed guard is **US$1.34829286 of US$10**.

[Sanitised attempt and reservation evidence](evidence/wave4-live-pi-20260915.json) records this checkpoint. Detailed raw artifacts and the persistent ledger remain in local operational storage. The coordinator was the existing Codex conversation; this is not evidence of a Helm Astra-driver invocation or Fable/Astra interchange.

## Guarded Map dogfood

The coordinator updated Map #1 through the accepted mutator inside an admitted, claimed and executed Kernel command. The adapter re-read membership and the exact issue revision before PATCH, rechecked host ownership/lease/hash authority, then confirmed the requested body by readback. It preserved the existing body and appended a dated progress section. The [receipt](evidence/wave4-map-mutation-20260915.json) records success at revision `2026-09-15T12:23:32Z`. GitHub issue PATCH remains read-before-write rather than an atomic revision CAS. No issue was closed.

## Accepted failure recovery, supervisor host and integration slice

PR #67 connects the durable supervisor to trusted host observations and command execution. PR #68 stops and quarantines failed native sessions. PR #70 removes repeated metadata scans from streamed journal appends while retaining durable per-hash sensitivity authority, and PR #71 redacts thrown stream exceptions before Core records them. PR #66 adds exact integration certificates and a durable gate/review evidence registry.

The combined main head `0c46dcbcdb86b013620b20cfc61a4b9694fe3543` passed Node 22.22.2 typecheck and **145/145 tests** using a private frozen installation. Final reviewed heads were:

| PR | Exact head | Independent validation |
| --- | --- | --- |
| #67 | `69a699fbfd7efd9651414316ad499a2b7613a2fa` | 129 tests, typecheck, host observation/epoch regressions |
| #68 | `f5fc5e25485e16f80a52cab27217bf9cc237a535` | 125 tests, typecheck, preserved native success/error/timeout cases |
| #70 | `fc76e5ffd8b440db16186a67181e18f8fe8c0a9f` | Spec: 126 tests and typecheck; Standards: code review and typecheck |
| #71 | `d10eab4fe03391e9c252cdc54900a19a416ab052` | Both reviews: 132 tests and typecheck; synthetic thrown-iterator redaction regression |
| #66 | `36c4ead2a696021f936eebefdb49a319e4a8e644` | Spec: 133 tests and typecheck; final Standards delta: 10 integration tests and typecheck |

Each final head had green CI before coordinator merge and observed merge readback. The integration tests include actual Core admission/claim/perform, a machine-produced local gate persisted through registry reopen, and refusal after target-only movement or callback-time CI change.

The production GitHub REST integration gateway still refuses to merge: source-SHA comparison does not atomically protect the target lane. A live read of this private repository's branch-protection endpoint returned a plan-related 403. No account plan or repository visibility was changed. Coordinator-reviewed development merges are authorised operations, not proof of Helm unattended production integration.

The matched journal workload improved from 78,379 ms to 29,359 ms for 1,000 appends. A separate native faux-provider stress run with tiny chunks and a 1,200 ms provider deadline drained to an honest unknown result in 43,955 ms, compared with approximately 116 seconds before the fixes. These are local measurements; provider timeout does not imply instant durable-event draining. Legacy journal writers must be quiescent during descriptor migration.

## Third native request: completed cognition, missing result

A fresh bounded supervisor-review attempt ran on accepted `d289c6c1c6a8e470049807aeb2a4a2d3767ee0f4`. The provider request completed and settled **US$0.00818485** of nominal token accounting. Its terminal event reported `stopReason: length`, 1,200 output tokens, and thinking content without answer text. The output allowance was exhausted before a WorkerResult envelope appeared. The host exited normally and recorded the outer attempt as unknown; it did not accept a review or claim the task succeeded.

At this checkpoint, two outer worker commands remained unknown. The earlier uncertain-provider attempt remained quarantined; the known-cost, missing-envelope worker lifecycle was finished after confirmed local stop. A finished lifecycle is not an accepted task result. The cumulative guard is **US$1.35647771 of US$10**: US$0.00905755 settled nominal accounting plus the original US$1.34742016 uncertain reservation. No reservation was reset or freed to create capacity. Actual incremental subscription billing and quota headroom remain unknown. [Sanitised third-request receipt](evidence/wave4-pi-review-after-fixes-20260915.json).

## Remaining work and next lane

Full Wave 4 acceptance remains open: this work has not yet produced a usable live engineering review/repair/merge receipt. A continuous supervisor still needs production source observers and frontier wake delivery. The integration transport needs a target-lane guarantee. Live Fable/Astra access, interchange, consultation and failover remain unproven.

Wave 5 starts with explicitly selected, bounded context manifests and native context-occupancy observation, followed by context-preserving recovery and compaction/model-change paths only after their model requests and ownership boundaries are covered. Draft PR #72 is not acceptance evidence. Calibration, complete original/addendum scenarios and legacy retirement remain open. OAuth-dependent work stays deferred; the existing overnight authority and cumulative budget continue to apply.


## Subsequent bounded correction attempt — 13:20 UTC checkpoint

A fourth native attempt used an 8,192-token output allowance and at most two requests, with one same-session envelope correction allowed. Both model commands remained unknown and their full reservations were retained; the outer command and lifecycle remained unknown. The host process exited normally. There is still no accepted engineering-review result.

[Sanitised correction-attempt receipt](evidence/wave4-pi-bounded-correction-20260915.json). Five native model requests have now occurred across four attempts. The cumulative ledger guard is **US$4.05131803**: US$0.00905755 settled nominal accounting plus three US$1.34742016 uncertain reservations. No Gemini request has occurred. Further API dispatch is paused while the pinned SDK thinking controls and native streaming path are investigated; no authority or ledger was reset. The two workers with only known model effects are physically finished; the two uncertain-provider attempts remain quarantined.

Offline inspection found that the pinned Kimi route has no supported separate thinking-budget field or proven provider-side disable mapping. Pi defaults its missing thinking configuration to medium; specifying off only omits a generic request field for this route. That is not proof of disabled provider reasoning. The event subscriber also queues complete growing message snapshots per update. Wave 5 now targets a lossless delta representation, bounded batched journal writes and explicit incomplete-tail handling. This work must be independently tested before another live attempt.

PR #72 has merged the scoped context/occupancy slice at reviewed head `10616040a5d249db4612847bf782d40a8785b234`. Both final reviewers ran the focused native/context tests and typecheck; the author full suite had 137 tests and CI was green. The combined main head `f89ed19a7bc5063bcb7d3e26d67a705223fa2f8f` subsequently passed typecheck and **147/147 tests**.

## Reviewed event and thinking controls — 13:47 UTC checkpoint

PR #76 merged at `2adc976` from reviewed head `8ea4e6f3ea3de448c34e27947e235819d59a8250`. It records trusted requested and Pi-native-selected thinking configuration, explicitly defaults to `medium`, and keeps provider effectiveness unknown. Root validation ran 148 tests and typecheck; independent Spec ran 25 focused tests and typecheck; six CI checks were green. Its pinned-SDK fake-fetch test shows that a compatible route receives the selected setting and that Kimi `off` only omits a generic request field. It does not establish that Kimi reasoning is disabled or change the existing spend, output, request, lease or reservation controls.

PR #75 merged at `d57d887` from reviewed head `4964e989934d80a7b2d1e1a3fd94ba06fc7375e4`. It journals Pi deltas in ordered bounded batches, snapshots events at observation, retains a valid buffered prefix before an explicit unknown tail, and preserves a terminal event larger than the ordinary batch threshold up to its documented hard event limit. The queue reserves room for both a buffered prefix and its overflow marker; it does not claim unavailable upstream backpressure. The author ran 154 tests and typecheck; independent Spec ran 17 focused tests and typecheck; independent Standards ran 11 focused tests and typecheck; six CI checks were green. The merged initialization retains PR #76's thinking configuration receipt.

## Deterministic Map closures — 13:43–13:47 UTC

Helm closed [#7](https://github.com/Nicegarrry/helm3/issues/7) and [#28](https://github.com/Nicegarrry/helm3/issues/28) through admitted, claimed deterministic `map.close` commands. #7 closed at revision `2026-09-15T13:43:23Z` under `map-authority-9df50b09-301d-41f8-a4fa-3405f436734e`; #28 closed at revision `2026-09-15T13:47:16Z` under `map-authority-e69d1b4f-59f2-46d5-ab3f-24b5d50e42b0`. Each receipt records readback success after the bounded read-before-write mutation path, so this remains a non-atomic GitHub concurrency observation.

The closures cover the deterministic authority/ownership acceptance scope: lease/refusal/reserve/quarantine behavior for #7 and ownership epoch fencing, stale callback refusal, consultant restriction and restart recovery for #28. The independent acceptance audit is bound by digest `sha256:e6cad45e37867b8e09841ebb310f129547ad39f1220b80f2b524d719c08326ff`; its [sanitised receipt](evidence/wave4-map-closures-20260915.json) omits raw operational content. These closures do not establish live provider cancellation, charges or quota observation; a production external observer, full frontier interchange and complete original/addendum acceptance remain open.

## Exact-head gate and fenced near-miss — 13:49–13:53 UTC

Helm's `runGate` primitive ran on clean exact head `d57d8870018d2de26c49deed32aef48af0516047` from `2026-09-15T13:49:51.630Z` to `2026-09-15T13:50:39.143Z`. Both `npm run typecheck` and `npm test` exited 0, and the receipt binds their immutable evidence artifacts to the same expected and observed head. This was a deterministic local gate; it made no provider call.

The fifth native attempt, `pi-supervisor-review-24982aed-550a-4ae7-b9b2-366f9ad3ac8e`, reached a provider terminal observation with `stopReason: stop`, validated token usage, and US$0.0217788 settled nominal cost. Its text was otherwise a WorkerResult-shaped result but was wrapped in one JSON code fence. The strict parser therefore refused it without an automatic correction or another request. The outer worker command remains `unknown`; its attempt lifecycle is `finished`. This is a formatting near-miss, not a recovered or accepted engineering-review run.

The [sanitised gate and near-miss receipt](evidence/wave4-gate-and-fenced-near-miss-20260915.json) records hashes, terminal counts and accounting without prompts, response text or raw thinking. The guard is now **US$4.07309683** across six requests and five attempts: US$0.03083635 settled nominal accounting plus US$4.04226048 retained uncertain reservations. There are no active Pi sessions and no further API dispatch in this checkpoint. Quota remains unknown. A deterministic fence-normalization repair is assigned; it has not yet converted this invocation into accepted work.

## Wave 5 and Wave 6 accepted slices — 14:36–14:40 UTC

PR #80 merged at `8121e669e76aa77ee2834f7af57e1acdd89efcae` from reviewed head `a42f0c7b9bb97792472b1f85cf8e0b6ecc6a7d26`. It adds the first bounded native Pi manual-idle compaction path. The Core effect now binds the checkpoint and terminal evidence, preserves the SDK's retained-context default, rejects concurrent or stale ownership, snapshots nested references before asynchronous reads, and rechecks the session and branch at effect time. Root validation ran typecheck and **168/168 tests**; independent Standards validation ran 11 focused tests and typecheck; six CI checks were green. This is a manual idle-compaction slice. Full context-pressure recovery, automatic compaction, model change and end-to-end recovery acceptance remain open.

PR #81 merged at `cfefb2f3037bfe1c57309552eb7b3d44716a3b72` from combined reviewed head `bdf2b61986a23dd74c1eb649aee1120d4839ffab`. It connects the host-owned bounded read registry to the actual provider-free operator and dogfood construction paths, so Fable and Astra can receive the same `brief.get`, `map.get`, `log.query`, `models.get` and `budget.get` surface. The slice keeps run and repository scope in trusted host context, fences driver sessions through durable ownership, returns metadata-only bounded SQLite tails, preserves honest unknown economy facts, and sanitises source failures. Author validation ran typecheck and **176/176 tests**; independent Standards and Spec reviews ran focused executable checks and typecheck; six CI checks were green. This establishes the read surface and its local wiring, not a live Fable/Astra provider interchange run.

The coordinator then ran Helm's `runGate` primitive against exact accepted head `cfefb2f3037bfe1c57309552eb7b3d44716a3b72` from `2026-09-15T14:40:51.750Z` to `2026-09-15T14:41:34.025Z`. Typecheck and the full suite both exited 0; hash-verified output recorded **176/176 tests passing**. The gate result artifact is `raw:sha256:a153da2fd54c0d0b7231d0f0d7d1435bd43fc24441a6737922759f85d2abd373`, with the full-test artifact `raw:sha256:eeb0c9585acd6d50cdff64567fa6df08a84e2b1dc268c2ea7a1b24172f90106e`. This is primitive dogfooding on the accepted head, not full SDK-orchestrator autonomy.

The latest saved Pi envelope remains an advisory, normalised report only. Its original invocation remains `unknown` with a `finished` lifecycle; the normalisation added no provider requests and did not rewrite historical reservations or status. The raw bytes and derived receipt are retained in private operational storage as recorded in the overnight handoff. No further provider request was made for this checkpoint.

The verified nominal guard remains **US$4.07309683**: US$0.03083635 known settled nominal accounting plus US$4.04226048 retained across three unknown requests. That represents six model requests across five attempts. Actual incremental OpenCode/Go charge and provider quota headroom remain unknown; no Gemini request occurred. The original Brief and addendum remain authoritative and full acceptance is open. The next implementation lane is the connected worker fleet (`worker.spawn`, `worker.inspect`, `worker.stop`) over the same host-owned control plane, followed by deterministic gate/review/integration adapters and later orchestrator failover and cockpit work.

The coordinator also dogfooded the Map update path against issue #1 through Core and the fresh GitHub mutator. Command `map-wave4-904d9980-4770-4b19-8806-aafa958ea51f` completed with readback at revision `2026-09-15T14:43:59Z` (observed `2026-09-15T14:44:00.093Z`), preserving state `OPEN`. The command hash is `sha256:55185b64dfe86e5709e7e49cd0af81517f700cb21d4ca6dc4e525ad37dab2d27`; the operation remains explicitly `read_before_write_not_atomic`. No new issue was closed.

## Wave 6 worker fleet and gate checkpoint — 16:33–16:41 UTC

PR #83 merged at `6e3aea64679b07cd54164c3497e0ccaf7d63c0ac` from independently reviewed head `464e458ccc7fe91faa129da0e60b2a815001947b`. It adds the bounded, host-owned native Pi worker primitive: asynchronous setup through `worker.spawn`, a durable bounded `worker.inspect` projection, and an independently admitted `worker.stop`. The slice records attempt/worktree/session launch provenance before work begins, keeps one writer in each isolated worktree, preserves unknown and confirmed-stop evidence across restart, and fences new work after an ownership transfer or autonomy-lease expiry. The final focused validation passed typecheck and 8/8 worker-fleet/connected tests with no cancellations; six CI checks and independent Standards and Spec reviews passed.

PR #84 merged at `af8d90695071c8f0ef6f7b3cbd010ec158f676ab` from independently reviewed head `04c4c32893b28235095c6d15cc39e8ede523582a`. It adds the shared bounded `gate.run` domain tool. The host resolves and snapshots registered checks, binds their derived digest and exact expected Git SHA in the immutable command, re-reads the clean head and authority at execution, and retains per-check evidence. The provider-free Fable and Astra fixtures each commit known worker output through deterministic fixture mechanics and call the same gate on that exact commit. Final focused validation passed typecheck and 9/9 gate/connected tests with no cancellations; six CI checks and independent Standards and Spec reviews passed.

Helm then ran its deterministic `runGate` primitive on clean accepted main `af8d90695071c8f0ef6f7b3cbd010ec158f676ab` from `2026-09-15T16:38:51.750Z` to `2026-09-15T16:40:02.556Z`. Typecheck and the full suite exited 0, with **185/185 tests passing**. The evidence hashes are recorded in the [sanitised receipt](evidence/wave7-worker-gates-20260916.json). This is local deterministic gate dogfooding. The native Fable/Astra fixtures are provider-free, and the coordinator's GitHub merges are manual operations rather than Helm production-integration evidence.

The coordinator updated Map #1 with an admitted, claimed and observed command. `map-wave4-1651a51f-6df4-44a0-9a65-42f1696e4ba1` completed with GitHub readback at revision `2026-09-15T16:41:01Z` (observed `2026-09-15T16:41:03.090Z`), preserving `OPEN`; the update remains `read_before_write_not_atomic` and closed no issue. The same sanitised receipt retains the command hash and evidence reference.

The nominal guard remains **US$4.07309683**: US$0.03083635 settled nominal accounting plus US$4.04226048 retained unknown reservations, across six requests and five attempts. No new paid call was made for this checkpoint; actual incremental charges and quota headroom remain unknown. Same-session steer is active implementation work, not accepted capability. Full Brief acceptance, live provider interchange, production Helm integration, review/repair/integration autonomy, and orchestrator failover remain open.

## Wave 8 accepted PR #86 and same-session repair checkpoint — 18:30–18:33 UTC, 15 September 2026

PR #86 was independently reviewed at head `257cc57dbdbf4eb0eb794c80be36ea2a6e5180b2` by Standards and Spec review, with six green CI checks, then merged as `8cb64a823783c78373976ee01ffda8a3af260beb` at `2026-09-15T18:32:16Z`. The accepted slice keeps the original command, attempt and generation records while adding same-session repair evidence. Current provider facts, the same history branch and the exact gate's canonical worktree remain bound; unknown provider and lifecycle facts stay unknown.

Helm's actual `runGate` ran against the exact PR head `257cc57dbdbf4eb0eb794c80be36ea2a6e5180b2` (the reviewed PR head, rather than the later merge SHA) from `2026-09-15T18:30:55.834Z` to `2026-09-15T18:32:01.592Z`. Typecheck passed and the full suite passed **196/196**. Both provider-free Fable and Astra scripted transports used the actual Pi SDK, Core, fleet and workspace paths to exercise red → same-context steer → green. The root foreign-worktree regression was red at `9efc3721f7e3d7bccc632316bca996e908a6b1da` and green after the repair; the preserved reports are `reports/tmp/helm3-pr86-root-spec-final.md`, `/private/tmp/helm3-pr86-gate-workspace-red.log` and `/private/tmp/helm3-pr86-gate-workspace-regression.log`.

The accepted Map #1 update was confirmed by readback: command `map-wave4-c9aa4fd7-cb2d-49f7-ab35-702f52330da8`, hash `sha256:fb479364f4b3093f89c9fe777184b114e3aa1c255643e41f3da8a493438852de`, revision `2026-09-15T18:33:46Z`, observed `2026-09-15T18:33:47.321Z`, state `OPEN`, with `read_before_write_not_atomic` concurrency. The update log is `/private/tmp/helm3-wave8-map-update.log`.

PR #87's independent read-only review remains a draft and is not acceptance evidence. Full cleanup and review remain ongoing; **QUALITY 19** remains open. The nominal guard is unchanged at **US$4.07309683**: US$0.03083635 settled plus US$4.04226048 retained unknown reservations. No new provider request or actual billing observation was made; actual billing and quota remain unknown. No keys, private prompts or full transcripts were recorded, and the Brief and addendum were not edited. New autonomous work stops at 22:00 Australia/Sydney on 16 September 2026.
