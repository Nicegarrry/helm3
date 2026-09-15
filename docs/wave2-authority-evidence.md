# Wave 2 authority and resource spine evidence

This kernel slice adds durable, transactional enforcement at the trusted host
boundary. A human authority grant is immutable and bounds repository/map scope,
actions, expiry, concurrency, attempts and named pool units. An Autonomy Lease
must fit inside that grant, so renewing a lease cannot enlarge its delegated
limits. Resource reservations are charged against the parent authority across
lease identities; unknown usage stays reserved until a later known settlement.

`KernelKind.resourceRequest` runs only after the kind payload has passed the
exact-semantics parser. Its output is persisted as the reservation used for the
effect. The kernel does not contact providers, infer quota, convert units to
dollars, route models, or fabricate usage. Immutable `ModelFact` snapshots can
only reject disabled, unavailable, role-ineligible or capability-ineligible
selections supplied by the caller.

Protected reserves apply to workers and consultants. Crossing one requires a
separate immutable, one-use human reserve exception that binds authority,
repository, lease, pool, unit, amount and expiry. The active orchestrator has
no path to self-authorise it.

`requestCancellation` records intent only. A pending or unknown worker stop is
quarantined as an unknown command and preserves the reservation. A confirmed
stop before an effect begins settles zero. `perform` remains the guard for each
effect: it rechecks claim, authority/epoch, cancellation and fresh facts after
awaited observation and records `effect_started` before invoking the adapter.

Focused evidence is `test/core/kernel.test.ts`: two SQLite connections compete
for reservations; the protected reserve and one-use exception are exercised;
unknown usage remains reserved over reopen; stale claims, epoch transfer,
restart after an interrupted effect and cancellation/quarantine are covered.

Limits: this is a library seam. It does not wire Pi, provider telemetry,
provider cancellation, actual model requests or tool actions. Pi must call the
trusted `perform` guard before every request and tool effect, then report stop
disposition and known/unknown usage through the lifecycle methods.
