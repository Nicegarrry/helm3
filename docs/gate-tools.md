# Bounded `gate.run`

`gate.run` is one host-owned Helm domain tool. An orchestrator supplies only a
registered gate ID, worker ID, and exact lowercase Git SHA. It cannot supply a
shell command, path, environment, budget, lease, or authority record.

The host snapshots and validates the registered gate definition before command
admission. The immutable `gate.run` payload binds the worker/workspace identity,
expected SHA, acceptance version, and a digest derived from the full configured
checks and environment. Immediately before execution it resolves the registry
again; any changed definition, acceptance version, or SHA leaves the Core
command unknown rather than running substituted checks.

Each check uses the existing `runGate` verifier. A real `git rev-parse` plus a
clean-worktree observation is re-read by Core before the effect, and again by
the verifier before every child process. The host also re-checks the active
effect's original ownership epoch, Autonomy Lease, and cancellation state before
each child. A red gate is durable evidence. A timeout, changed workspace,
expired lease, failed evidence write, or interrupted effect is unknown.

The provider-free connected Fable/Astra fixture exposes the same composed host
registry including `gate.run`. It intentionally leaves the worker worktree
dirty, so it proves registration and fencing but does not claim a green
post-worker gate. A future acceptance run should commit or otherwise prepare a
clean registered worker head, invoke the tool through a driver, and verify the
resulted GateResult against that exact head.
