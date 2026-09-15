# Manual Pi compaction

`PiNativeWorker.manualCompact` is a host-only, idle-worker operation. It requires a distinct `pi.compact` Core command binding; that control command does not reserve or settle provider spend. Each summary request remains a separately admitted `pi.model` effect through the guarded runtime and `BoundedPiAccess`.

Before the effect, Helm copies and verifies immutable objective, acceptance, Brief, Map, decision, and at least one handoff artifact. It captures the current session and branch digest, then checks that exact context again inside the admitted effect. The persisted checkpoint retains those named evidence roles with the owner, attempt, session, model/thinking receipt and occupancy observation. A missing current-context observation is recorded as unknown.

The Core success observation contains the actual raw references for both the checkpoint and the terminal compaction evidence. If either terminal evidence persistence or the final event drain fails, Core records the control effect as unknown rather than successful. The operation owns the worker slot from validation through the native summary, so run, reopen and another compaction cannot interleave. Manual compaction leaves Pi's retained-context setting at its SDK default; only automatic compaction is disabled.

This slice does not expose Pi model changes, automatic compaction, extension hooks, or provider setup.
