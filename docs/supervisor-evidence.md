# Fleet terminal evidence and supervisor delivery

`PiWorkerFleet` owns the narrow bridge from a native terminal observation to
the deterministic supervisor. After a worker writes its immutable
`terminal-known` or `terminal-unknown` effect, it appends the corresponding
`host.worker_fleet` event and calls `HostControlPlane.createSupervisor().process`
with a signal only. It supplies no retry input, executor, command, provider
fact, or model callback.

The signal binds the persisted fleet event ID as `sourceEventId`, the admitted
spawn or steer command's run, attempt, worker and Map node, and the event's
original observation timestamp. It reads the exact terminal phase matching
that event and carries its hash-checked evidence references. A later confirmed
stop or stronger terminal projection cannot rewrite the bytes of an earlier
signal. Invalid event, command, attempt, worker, session, Map-node, or effect
bindings do not create a supervisor signal.

An envelope-backed successful `worker.completed` is informational and produces
no wake. An envelope-backed terminal result of `failed` or `partial` remains a
completed-worker fact but requests judgement; this is distinct from a
`worker.failed` terminal-unknown infrastructure observation, which also
requests judgement. The result status is used only when exactly one
hash-checked Pi terminal envelope in the immutable evidence chain matches the
fleet event. A missing status, invalid or corrupt envelope, or multiple valid
envelopes emits no completion signal; the durable fleet event remains available
for later evidence/reconciliation without being guessed as success. Expired or replaced
owners leave the cause durable; a later active owner may record its own wake.
The bridge never treats an unknown native outcome as a physical-death fact,
never retries, and never starts a Pi worker or provider request.

The host is a library and has no constructor-time recovery loop. A host that
has reopened its state calls `await fleet.replaySupervisorEvents(runId)` after
its normal `await host.recover(runId)` and fleet construction. Replay scans
only existing terminal `host.worker_fleet` events and reuses each stored event
ID, so an append-to-delivery interruption and repeated replay add no duplicate
cause or wake. It performs no process discovery or worker recovery.

Supervisor delivery is best-effort after the durable fleet append. A delivery
exception is swallowed so it cannot reinterpret a completed worker as failed
or unknown, and the same recorded event remains available to the explicit
replay hook. `test/host/fleet-supervisor.test.ts` covers native success and
unknown outcomes, a fault after append before delivery, close/reopen replay,
and repeated-replay deduplication with no additional Pi start or run.
