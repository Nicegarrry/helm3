# Wave 2: connected supervision

The user explicitly renewed execution on 16 September 2026: make Helm 3 public, merge reviewed PRs, and continue Wave 2 with Gemini/Qwen. This is Wave 2 in the [remaining-work plan](open-model-waves.md), not the historical SDK-library wave.

The repository is public. PR101–105 are merged after successful GitHub checks. The combined content passed an actual Helm gate with 282 tests and typecheck; final main `7991467` has identical content and green main-branch CI. These were coordinator-managed merges, not evidence that Helm's production integration gateway is complete.

The user renewed execution again at 05:05 UTC on 16 September: continue Wave 2 using more resources as needed. The current operational run expires at 2026-09-16T08:05:00Z, with 64 worker attempts and at most three concurrent workers. The daily combined OpenCode/Gemini ceiling remains US$20. All prior settled usage and unknown reservations remain in the same ledger; no accounting reset. The old grants reached their attempt caps and the new user instruction authorises a new bounded run. Preserve a 35% Codex reserve. Predominantly native Pi Gemini/Qwen workers perform implementation and review.

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

## Write refusal before effect admission

Dogfooding exposed a distinction between a known write-policy refusal and an uncertain admitted effect. Native Pi now performs a read-only workspace ownership/path preflight before submitting `pi.write`. A protected or out-of-scope path produces a durable Pi tool error without inventing an effect command; the same session can correct its request. The preflight creates no directories and grants no permission.

Every original ownership and path check remains inside the actual write. A race or error after admission remains an unknown command requiring reconciliation. This does not reinterpret historical unknown commands or release their resource reservations. The native provider-free regression exercises the real Host/Kernel, semantic journal and attempt lifecycle; live provider work and production frontier acceptance remain separate evidence.

## Process identity and restart observation slice

Native Pi sessions execute inside their owning host process. Persist the host identity, boot identity, PID and process start token with each new worker invocation. A trusted local observer compares those facts freshly; PID existence alone is insufficient. Foreign hosts, inaccessible process information and legacy records without identity remain unknown. Process liveness is distinct from native worker/task state.

A restarted fleet may observe the old owner process without possessing its native session handle. A matching process and workspace owner is quiet. A dead owner, missing identity or changed workspace ownership produces a durable, coalesced reconciliation question. Monitoring continues after authority expiry and does not authorize a retry, mark work complete or clear uncertain effects. Provider/file effects may have occurred before process death.

Required proof: actual OS process identity and child-process death, PID reuse/error cases, real Host/Kernel fleet restart observations, stable causes across replay, expired-lease monitoring without spending and no automatic lifecycle clearance. This connects observations to supervision; verified absent-effect retry and operational bootstrap require separate evidence.

The implementation uses `LocalProcessProbe` with a host identity supplied by trusted configuration. Linux uses boot ID and process start ticks; macOS uses boot time and `ps` start time (second precision). This is liveness evidence, not an exclusive execution lock or proof that remote effects are absent. New fleet records capture identity on spawn, continuation and fork; legacy records remain readable.

Hosts can connect `fleet.observeProcesses(runId)` through the runner's trusted observation callback. Stable event identities deduplicate repeated observations and competing host connections. The original observation timestamp remains attached to the original cause. A missing session handle remains unknown even when its owner process exists. Normal CLI bootstrap and fresh absent-effect retry authorization are still separate outstanding work.

Live dogfooding found that immutable attempt history may have empty command IDs. Observation therefore binds through the trusted launch record rather than requiring that optional history. The regression uses the same empty-history shape; removing the correction reproduces the missing observation.
