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

`worker.steer` is an idle-only continuation, never a retry or a new repair
worker. It accepts a persisted Pi session only after the preceding invocation
is durably terminal, its native session ID and transcript hash remain intact,
the assigned worktree is clean at the supplied exact SHA, and the old writer
generation transfers once to a fresh continuation attempt. The continuation
command binds its generated successor ID, predecessor ID, copied tool input,
model/fact/policy provenance, and the verified head. Pi reopens under fresh
authority and must report the same session and model identity. A currently
running, unknown, cancelled, stale, expired, changed-head, or already-taken
predecessor is refused before a model or write effect. When a gate is cited,
its command ID and raw refs are checked against the recorded gate for that
predecessor and exact head; arbitrary host notes cannot substitute for gate
evidence. A persisted transcript is not session discovery: missing or changed
history remains unrecoverable.

`worker.fork` is an idle-only, host-owned native Pi branch copy. It accepts
only a durable terminal source with the exact native session ID, session-file
hash, branch digest, clean verified Git head and current ownership/lease
epoch. The host creates a fresh attempt and a separate owned worktree, then
uses Pi's persisted-session branch operation to create a new session file at
the current tip. The resulting child is persisted as `fork_ready`: it is
inspectable and locally stoppable, but has no WorkerResult and has made no
model request. A subsequent `worker.steer` may activate that child only after
the same identity, head and authority checks; it transfers the child's own
worktree generation once. Fork inherits context and therefore cannot be used
as independent review. Any uncertain creation or evidence observation remains
unknown and is never replayed.

This slice does not implement Pi session discovery, pause/resume/model
change, automatic retry, live provider/OAuth acceptance, frontier wake
delivery, or OS shell containment. A provider-free faux run proves
control-plane plumbing only; worker claims remain claims until a gate or review
checks evidence.
