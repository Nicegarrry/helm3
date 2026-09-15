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
registry including `gate.run`. After its faux Pi worker produces the known
`result.txt`, trusted fixture mechanics commit that generated file in the
worker's isolated worktree. Each driver then invokes `gate.run` for the exact
resulting SHA. The content check passes only when the committed file has the
expected bytes, and the test reads the succeeded command's evidence references
and bound SHA back from the durable Host projection. This is fixture-only
mechanics, not an agent Git role or a prescribed production workflow.
