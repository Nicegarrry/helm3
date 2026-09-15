# Wave 2 authority and resource spine evidence

This kernel slice adds durable, transactional enforcement at the trusted host
boundary. A human authority grant is immutable and bounds repository/map scope,
actions, expiry, concurrency, attempts and named pool units. An Autonomy Lease
must fit inside that grant, so renewing a lease cannot enlarge its delegated
limits. Resource reservations are charged against the parent authority across
lease identities. The cap includes every unsettled upper bound and every
settled observed actual. Unknown usage stays reserved until a later final
observation; each usage observation is appended durably before settlement.

`KernelKind.resourceRequest` runs only after the kind payload has passed the
exact-semantics parser. Its output is persisted as the reservation used for the
effect. The kernel does not contact providers, infer quota, convert units to
dollars, route models, or fabricate usage. `ModelFact` observations have a
monotonic `factVersion` and `observedAt`; the newest version is current while
prior versions remain immutable. The kernel checks current
enabled/availability/role/capability facts at admission and again immediately
before an effect after awaited fact reads. A selected model's pool must equal
the request's charged pool.

Protected reserves apply to workers and consultants. Crossing one requires a
separate immutable, one-use human reserve exception that binds authority,
repository, lease, pool, unit, amount and expiry. The active orchestrator has
no path to self-authorise it.

`requestCancellation` records intent only. A pending or unknown worker stop is
quarantined as an unknown command and preserves the reservation and capacity.
A confirmed stop settles zero only while the command was claimed and no effect
identity exists. `perform` remains the guard for each effect: it rechecks
claim, authority/epoch, cancellation and current model facts after awaited
observation and records `effect_started` before invoking the adapter.

Worker commands carry a host-authenticated `TrustedCaller.attemptId`, never a
model-selected payload identifier. The kernel persists that identity with the
parent authority, lease, repository and map node at admission for every worker
command, including resource-free model and tool calls. It allows multiple tool
commands in the same attempt but cannot rebind one attempt to another scope.
Lease and parent concurrency count the durable active attempt across command
gaps and include quarantined unknown attempts. `reportAttemptStop` is a trusted
runtime lifecycle report: only a confirmed stopped attempt with no unresolved
commands releases capacity; pending and unknown reports quarantine it. Attempts
per node use typed columns and enforce both the lease and parent limits across
lease renewals.

Focused evidence is `test/core/kernel.test.ts` and
`test/core/authority-regressions.test.ts`: two SQLite connections compete for
reservations; settled use, stricter lease reserves, parent-map narrowing,
attempt and concurrency limits, versioned model facts, and stop races are
covered alongside stale claims, epoch transfer, interrupted-effect recovery and
cancellation/quarantine.

Limits: this is a library seam. It does not wire Pi, provider telemetry,
provider cancellation, actual model requests or tool actions. Pi must call the
trusted `perform` guard before every request and tool effect, then report stop
disposition and known/unknown usage through the lifecycle methods.
