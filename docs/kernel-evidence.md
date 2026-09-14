# Kernel evidence

Status: first-wave local deterministic evidence, not a provider or runtime
acceptance claim.

The kernel uses Node 22.22.2 `node:sqlite` `DatabaseSync`. Node's current
documentation records it as available without the former SQLite flag from
Node 22.13.0, while the module remains experimental. The implementation uses
parameter binding, `BEGIN IMMEDIATE` transactions, WAL mode, and a finite busy
timeout. It is a single-host foundation; it does not claim distributed exactly
once semantics, public API authentication, provider quarantine, resource
accounting, or SDK/GitHub execution.

The trusted embedding receives a separate `KernelHost` for issuing/revoking
Autonomy Leases, acquiring ownership epochs, and explicit restart recovery. A
model-facing `KernelClient` facade has only command, claim, effect, observation,
and append-only Log operations. This is a library capability boundary, not an
authenticated transport boundary.

Admission replaces the supplied actor with the trusted caller identity, checks
the registered payload schema, recomputes the exact persisted payload hash, and
checks lease scope/action/revision/expiry. Orchestrator admission also requires
the active ownership lease, epoch, active time window, and authenticated
session. Missing map-node scope and unsupported resource-enforced kinds refuse.
The persisted clock high-water mark refuses an authority decision after a wall
clock rollback.

`perform` obtains fresh predicate observations through its callback. A known
false value, unknown state, or version mismatch refuses before `effect_started`.
It rechecks claim, authority, and ownership immediately after the awaited reads,
then commits `effect_started` before awaiting the effect. An effect must be
observed separately; an exception or interruption becomes `unknown` and cannot
be claimed for blind replay. Observed terminal results can be appended after an
ownership transfer, but a later stale result cannot overwrite an existing
terminal record.

The test suite proves close/reopen durability, idempotency collisions, event
source deduplication, immutable attempts, lease refusals, stale claims,
two-connection ownership CAS, supervisor continuity, actor spoof prevention,
false-known preconditions, and a child process killed after an external marker
write and before result recording. Explicit host recovery converts that durable
`effect_started` state to `unknown`; normal second connections do not recover
live claims.
