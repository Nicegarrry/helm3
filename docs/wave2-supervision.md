# Wave 2: connected supervision

The user explicitly renewed execution on 16 September 2026: make Helm 3 public, merge reviewed PRs, and continue Wave 2 with Gemini/Qwen. This is Wave 2 in the [remaining-work plan](open-model-waves.md), not the historical SDK-library wave.

The repository is public. PR101–105 are merged after successful GitHub checks. The combined content passed an actual Helm gate with 282 tests and typecheck; final main `7991467` has identical content and green main-branch CI. These were coordinator-managed merges, not evidence that Helm's production integration gateway is complete.

The renewed operational run expires at 2026-09-16T04:05:00Z. The daily combined OpenCode/Gemini ceiling remains US$20. All prior settled usage and unknown reservations remain in the same ledger; no accounting reset. The old grants reached their attempt caps and the new user instruction authorises a new bounded run. Preserve a 35% Codex reserve. Predominantly native Pi Gemini/Qwen workers perform implementation and review.

## Scope

Connect existing durable supervisor signals and fresh-checked retry mechanics to long-running operation. Workers and hosts may restart without duplicate effects. Lease expiry stops new spending. The supervisor wakes an orchestrator only when judgement is pending.

The first missing connection is wake delivery. `EventSupervisor` already persists and coalesces wakes, while drivers already accept event references and invoke a turn. A host bridge must connect them through a validated command and the Kernel's claim/effect/observation path. It must not treat a returned reference or model-written success claim as proof of a successful invocation.

## Required proof

- A quiet run creates no invocation or spending command.
- A pending wake invokes the bound session under current ownership and autonomy authority.
- Successful invocation evidence is observed before acknowledging handled causes.
- Restart after completion can acknowledge without invoking again.
- An interrupted or uncertain invocation remains pending for reconciliation; it is never blindly replayed, including when a new event enlarges the wake group or ownership changes.
- Concurrent delivery callers do not create duplicate invocations.
- Expiry or revocation between event delivery and invocation prevents the model call.

Use the actual Host/Kernel/EventSupervisor with provider-free drivers for deterministic boundary tests. These tests do not establish authenticated Fable/Astra operation. Native Gemini/Qwen workers build and review the change; they are separate from the tested frontier driver.

Continuous observation, process/session reconciliation, normal CLI bootstrap and the complete live acceptance scenario remain open until their own evidence is recorded. The authorised predecessor role-tier import remains part of the later economy integration; no model roster or training policy changes are implied by repository publication.

## Wake delivery implementation

`HostWakeDispatcher` connects pending supervisor causes to the configured driver through a normal admitted command. The host supplies command planning, fresh fact reads, a bounded driver and result verification; this helper never grants authority or chooses a model. Invocation artifacts can be read through the scoped `HostArtifactStore.readInvocation` capability. Model-written success text is not the invocation outcome.

Kernel claims prevent duplicate execution of the same command. Durable claims on individual causes also fence different commands created by concurrently changing wake groups. Claim conflicts and uncertain effects stay unresolved for reconciliation; this does not promise exactly-once provider execution or automatic replay. Successful observed commands can acknowledge their original causes after restart without invoking again.

The Gemini implementation and tests were repaired using its retained Pi session. Coordinator verification corrected payload hashing, queue input capture, clock validation, recovery reporting and test API mismatches, and added actual two-connection race and authority-loss cases. Qwen's initial stub proposal was preserved but rejected. Worker envelopes and claims do not substitute for the coordinator's executed checks.

## Continuous observation slice

`HostSupervisorRunner` is a trusted host composition over real fleet event replay, observation callbacks, the existing supervisor and wake dispatcher. `run(AbortSignal)` repeats serialized cycles at a bounded interval; `tick(AbortSignal)` supports an explicit host lifecycle. A quiet cycle creates no model invocation. Observations and evidence continue after authority expiry, while the dispatcher refuses new spending.

The configured run and primary session are captured once. Observations from another run are rejected before processing, and each signal-processing promise is awaited before dispatch. Cancellation stops further stages and is also checked inside dispatch before event delivery, before invocation and between wake groups. An already started provider call may finish; cancellation does not claim to undo it.

This slice consumes trusted signals only. It does not infer process death, manufacture retry authority, select models, renew leases or call `Host.recover` over possibly live effects. Automatic process discovery, the source of verified retry facts and normal operational CLI bootstrap remain open. Existing deterministic retry commands still require their own fresh evidence and authority.

Unit tests use a named replay double for loop boundaries and real Host/Kernel/dispatcher for effect boundaries. The fleet regression also exercises the runner with actual PiWorkerFleet replay and a provider-free worker fixture, including refusal of undelegated wake spending. Live Pi dogfooding is recorded separately; provider-free tests are not live Fable/Astra acceptance.
