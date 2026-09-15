# Manual Pi compaction

`PiNativeWorker.manualCompact` is a host-only, idle-worker operation. It requires a distinct `pi.compact` Core command binding; that control command does not reserve or settle provider spend. Each summary request remains a separately admitted `pi.model` effect through the guarded runtime and `BoundedPiAccess`.

Before the effect, Helm verifies immutable objective, acceptance, brief, Map, decision, and at least one handoff artifact, then persists a checkpoint with the current owner, attempt, session, model/thinking receipt, occupancy observation, and a digest of the current Pi session branch. A missing current-context observation is recorded as unknown. A failed or interrupted compaction leaves the prepared checkpoint and the Core effect for recovery; Helm does not replay it blindly.

This slice does not expose Pi model changes, automatic compaction, extension hooks, or provider setup.
