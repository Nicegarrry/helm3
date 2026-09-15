# Worker fleet vertical slice

`worker.spawn`, `worker.inspect`, and `worker.stop` are host-owned entries in
the shared Helm tool registry. Fable and Astra transports receive the same
registry; the loopback operator may expose `worker.inspect` only as a GET read.

Spawn is deliberately a short Core effect. It admits immutable command intent,
records attempt provenance, verifies the base SHA, creates an owned worktree,
starts Pi, and persists a launch record before its successful observation. The
long Pi invocation is a tracked background promise. Each model request and
write remains independently admitted through the existing Pi authority.

`worker.inspect` returns a bounded projection. A recovered process has no
claimed live Pi session, so it reports `live: "unknown"`; it does not claim a
resume, completion, or remote cancellation. `worker.stop` is a separate Core
command and uses the native local-abort seam without changing the succeeded
spawn command. An unknown stop retains the attempt's unknown disposition.

This slice does not implement Pi session discovery, cross-process resume,
pause/resume/steer/fork/model-change, automatic retry, live provider/OAuth
acceptance, review/gate/integration workflow, frontier wake delivery, or OS
shell containment. A provider-free faux run proves control-plane plumbing only;
worker claims remain claims until an appropriate gate or review checks evidence.
