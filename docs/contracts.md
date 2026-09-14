# Helm 3 proposed control-plane contracts

Status: proposal for build approval. This describes the durable kernel the first
implementation must prove; it does not prescribe a worker workflow.

## Ownership and authority

The human owns the Brief and all fixed requirements. Fable owns a fluid Map
within that Brief and may propose, never silently apply, Brief changes. GitHub
is authoritative for issue and PR state; Git/CI for repository reality; Pi for
live native sessions; Helm's append-only Log for orchestration history. Cockpit
and CLI are projections over the same API and never authorise action.

`AutonomyLease` grants bounded dispatch, retry, review, gate and integration
authority for a Map scope. It includes expiry, per-pool limits, concurrency,
attempt limits and an orchestrator reserve. Expiry stops new spending and
in-flight effect dispatch; safe observation and evidence capture continue.
Cancellation requests are recorded and reconciled. A worker that cannot be
confirmed stopped is quarantined from new authority and surfaced to Fable.
Only a human can approve consumption of the orchestrator reserve or a Brief
change.

## Commands and evidence

Every consequential action has `intent -> pure plan -> immutable validated
command -> execution -> observed result`. A command contains ID, type,
authority snapshot, exact preconditions, idempotency/replay key, planned effect
and evidence requirements. Effects re-read fresh external facts immediately
before execution. The resulting observation, including an unknown/ambiguous
outcome, is appended to the Log; ambiguous effects are reconciled, never blindly
retried. Safe replay requires the same key and a confirmed absent effect.

Hard refusals cover invalid role/capability, prohibited data policy, disabled
model, unowned workspace/path, absent required oracle, non-independent review,
and delegated-authority violation. Provider quota, rate limit and availability
are physical constraints. Budget/concurrency targets are separately authorised
resource refusals. Unknown quota, usage, cost, reset or availability remains
unknown and is never converted to a reassuring value.

## Attempts, sessions and workspace

An `Attempt` is durable and immutable in historical facts: map node, objective,
role label, model/family/provider/pool, session, worktree, start/end, command
IDs, usage/cost observations, outcome, findings, evidence and handoff.
`Session` ownership binds one live Pi session to one active attempt and lease.
One writer owns one isolated worktree. Reviews use detached read-only worktrees
where possible and must be independently attributed.

Pi extension hooks are useful but insufficient as the only write boundary:
shell tools and child processes need an OS/worktree containment design. The
vertical slice must document and test the actual boundary for paths, Git target,
network/tool permissions and subprocess escape behaviour. Failed worktrees are
preserved until an explicit reclamation command observes them safe to reclaim.

## Supervisor, queues and recovery

The deterministic supervisor performs only unambiguous lease-authorised
transitions: record events, collect results, bounded retry, launch a required
review, block on provider limits and reconcile. It never invents a plan. Events
that need judgement create a deduplicated, coalesced Fable wake reason; Fable
does not poll routinely. The orchestrator queue contains operational judgement;
the human queue contains only product ambiguity, fixed-Brief changes, material
risk or spending beyond authority.

Reconciliation compares desired records with Pi sessions/processes, worktrees,
GitHub/CI and Git. It repairs only safe mismatches and queues ambiguity: dead
recorded session, orphan worktree, interrupted integration, completed attempt
without handoff, expired lease, or merged PR with an open Map node.

## Integration and closure

Workers never merge their own change. `IntegrationPrepare` binds an expected
head SHA, fresh mergeability, CI on that SHA, required independent approval on
that SHA, and exact acceptance evidence. `IntegrationMerge` re-reads all of
those facts immediately before the irreversible action and reads back the
result. Any changed head invalidates preparation.

A Map node closes only after repository/CI reality and acceptance evidence agree,
required handoffs are durable, dependencies are resolved, and Fable records a
closure rationale. A merge alone is not closure; a UI projection alone is not
evidence.

## Economy and context

The model registry exposes provider facts, capability/role floors, pool,
availability, data policy and observed calibration. Fable chooses legal models;
Helm reports compact resource reality and refuses illegal choices. Subscription
capacity, API spend and top-up pools remain distinct. Calibration is evidence
for Fable, never an automatic re-tiering rule.

Context is deliberately scoped to objective, acceptance, relevant Brief and Map
branch, decisions, dependencies and code evidence. Every substantial attempt
ends in a structured handoff: summary, changes/commits, tests and acceptance
evidence, decisions, discoveries, risks, questions and recommended action.
