# Proposed Helm 3 Map and build plan

Status: proposed Map, pending the `APPROVAL` gate. It is a changeable approach
to the approved Brief, not a workflow DSL or a promise that elapsed time alone
authorises action.

## Outcome

Deliver a local Helm 3 control plane in which a human Brief is pursued by Fable
through a fluid GitHub-backed Map, Pi-native workers, durable evidence and
bounded autonomous authority. The full-brief capability is the target of this
build; later phases sequence risk and polish, rather than silently defer core
invariants.

## Proposed 24–48 hour operating approach

Start with broad interfaces and one vertical slice, then fan out across three
isolated worktrees. Terra handles runtime/kernel/integration slices; Luna
handles mechanical API, fixtures, projections and documentation; frontier
coordination owns contracts, cross-cutting decisions and acceptance. Limit to
three active workers plus coordinator until machine and provider capacity is
observed. Verify every dispatched brief against the accepted design and ticket.

Hours 0–6: freeze behavioural expectations, write contracts, create Map and
prove local/no-cost Pi and Agent SDK seams through mocks or public SDK reads.
The six-hour checkpoint is observational: it reports discovered interfaces,
credential/provider blockers and revised sequencing; it is not a guaranteed
completion gate.

Hours 6–24: build the command/log/authority spine, Pi session vertical slice,
and shared API/projection in parallel. Hours 24–40: connect Fable, supervisor,
lease/recovery, verification/review/integration and economy. Hours 40–48: run
the complete acceptance scenario, inject faults, repair and rerun. If concrete
runtime/authentication/isolation failures appear, retain the same Map and allow
48–96 hours for integration repair; report evidence rather than substituting a
claim of autonomy.

## Dependencies and migration boundary

No predecessor source, tests, credentials or working state are read or imported
until Opus supplies an explicit Milestone 1 handoff with immutable SHA. The
reuse lane then classifies predecessor tests as behavioural or
implementation-specific, pins the SHA in the Log, and ports only verified
behaviours behind Helm 3 interfaces. It never blocks greenfield contracts,
runtime proof, or mock/local preparation.

## Freeze checklist

Before product build, record: Brief version and fixed requirements; source-of-
truth table; refusal classes; command schema and unknown-outcome rule; lease
expiry/cancellation semantics; Attempt/Session/worktree ownership; evidence-
bound integration predicate; Map closure predicate; provider and OS isolation
assumptions; required machine gates; and exact section-35 acceptance scenario.

## Acceptance run

One real feature must demonstrate: human outcome and Brief; Fable Map change;
at least three parallel Pi workers; Fable model choice from resource facts; a
worker failure handled by supervisor or correctly escalated; an independent
review; an implementation repair; exact-SHA evidence-bound merge; Fable restart
mid-run with reconstruction; lease expiry or renewal; durable handoffs; final
Map state matching repository reality; and CLI/Cockpit projection agreement.
The run must clearly distinguish mock/provider-free evidence from live-provider
evidence.
