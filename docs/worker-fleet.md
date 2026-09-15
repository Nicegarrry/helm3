# Worker fleet vertical slice

`worker.spawn`, `worker.inspect`, and `worker.stop` are host-owned entries in
the shared Helm tool registry. Fable and Astra transports receive the same
registry; the loopback operator may expose `worker.inspect` only as a GET read.

Spawn is deliberately a short Core effect. Its immutable command binds the
validated objective, acceptance and context artifact references by digest, as
well as the selected model, model-fact version, data policy and base SHA. The
host reads every referenced artifact, checks that the attempt/worktree use that
base SHA, and checks Pi's selected SDK model before it starts the worker. It
then records attempt provenance, creates an owned worktree, starts Pi, and
persists a launch record before its successful observation. The long Pi
invocation is a tracked background promise. Each model request and write
remains independently admitted through the existing Pi authority.

`worker.inspect` returns a bounded projection. Completion and confirmed local
stops persist a terminal effect record, so they survive a host restart. A
recovered process still has no claimed live Pi session and reports
`live: "unknown"`; it does not claim a resume or remote cancellation. A
mid-effect crash has an unknown disposition and remains quarantined rather than
being replayed. `worker.stop` is a separate Core command and uses the native
local-abort seam without changing the succeeded spawn command. An unknown stop
persists its cancellation request and retains the attempt's unknown
disposition.

This slice does not implement Pi session discovery, cross-process resume,
pause/resume/steer/fork/model-change, automatic retry, live provider/OAuth
acceptance, review/gate/integration workflow, frontier wake delivery, OS shell
containment, or runtime verification that a later provider request still uses
the original provider/API identity. A provider-free faux run proves
control-plane plumbing only; worker claims remain claims until an appropriate
gate or review checks evidence.
