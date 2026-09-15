# Durable supervisor queue and recovery classification

This slice implements the event and judgement queue foundation for original sections 11–12, 25 and addendum 7–12. It stores signals and acknowledgements in the existing Helm Log, not a second task database. It does not claim a continuously running full supervisor or automatic dispatch is complete.

`EventSupervisor.record` accepts trusted runtime observations with stable source event identities. Exact duplicates do not create repeated records; identity collisions with different facts refuse. Quiet systems and purely informational gate results produce no judgement wake. `pending` coalesces unresolved signals by run and semantic group under the current orchestrator epoch. A replacement owner sees unhandled causes without inheriting an old controller's mutation authority.

Acknowledgement records handled causes, not successful delivery of a model request. A delayed acknowledgement consumes only its original causes, preserving newly arrived events. Kernel-owned event append checks ownership and commits the event in one SQLite transaction, fencing takeover races. Model wake delivery itself still needs a bounded command admission; reading this queue spends nothing.

`planRecovery` is a pure mechanical classifier over fresh runtime/effect/provider/lease observations. It proposes retry only for a confirmed stopped, dead, transiently failed worker whose previous effects are confirmed absent, with available provider and still-valid retry/attempt authority. Unknown or present effects never trigger replay. Quota or unknown availability stays blocked until fresh observations; reset timestamps alone are not evidence of recovered provider capacity. Expired/revoked authority blocks new retry while observation remains available.

A retry proposal is not authority or execution: the host must construct a new attempt and admit its deterministic command under freshly checked Kernel lease, resource and concurrency rules before any side effect. The full Pi/Git/worktree/CI observer loop and delivery connection remain integration work. No subjective model-quality failover or fixed workflow graph is introduced.

`HostControlPlane.createSupervisor()` is the provider-free integration point. Its
single serialized processor accepts an explicit trusted observation plus an
optional prebuilt `supervisor`-origin retry command. It exposes only the narrow
`SupervisorLog` capability for delivery/status adapters. A retry goes through
Kernel admission, claim and `perform`; the caller's fact reader is called at the
effect boundary, so unknown or stale facts refuse before the runtime effect.
The processor returns an already-terminal idempotent command without another
effect after restart. Coalesced primary wakes are durable `supervisor.wake` Log
events, fenced by the current owner epoch. Provider, Git, CI and Pi observers
are deliberately not implemented by this slice: an adapter must supply their
trusted observations before any corresponding mechanical action is possible.

The Log query is bounded at 10,000 correlated events and fails explicitly on overflow. A production cursor/archival mechanism is follow-up work; the query never silently truncates unseen wake causes.

Provider-free tests use a real reopened SQLite Kernel to prove deduplication, coalescing, no quiet wake, scoped runs, durable acknowledgement, takeover fencing including at-append transfer, preservation of later causes, conflicting evidence refusal and lease/provider/effect retry classification.
