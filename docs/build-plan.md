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

## Proposed build operating approach after approval

Start with broad interfaces and one vertical slice, then fan out across three
isolated worktrees. Terra handles runtime/kernel/integration slices; Luna
handles mechanical API, fixtures, projections and documentation; frontier
coordination owns contracts, cross-cutting decisions and acceptance. Limit to
three active workers plus coordinator until machine and provider capacity is
observed. Verify every dispatched brief against the accepted design and ticket.

After approval, start with broad interfaces and the Pi vertical slice, then fan
out across kernel/authority/economy, runtime/context/external cognition, and
Map/Fable/client work. The first six hours of the build are an observational
checkpoint: report discovered interfaces, provider/authentication/isolation
blockers and revised sequencing; it is not a guaranteed completion gate.

Target the first 24 hours at the command/log/authority spine, Pi session slice,
shared Map/API, and resource view. Target hours 24–40 at Fable, supervisor,
context/model-switch, external cognition, dynamic review, quality and
integration. Target hours 40–48 at the complete acceptance scenario, injected
faults, repair and rerun. If concrete runtime, authentication or isolation
failures arise, retain this Map and allow 48–96 hours for integration repair.

## Dependencies and migration boundary

No predecessor source, tests, credentials or working state are imported until
Opus supplies an explicit Milestone 1 handoff with immutable SHA. Receipt of
that handoff is independent of build approval. The later approved import lane
classifies predecessor tests as behavioural or implementation-specific, pins
the SHA in the Log, and ports only verified behaviours behind Helm 3 interfaces.
It never blocks greenfield product slices.

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
