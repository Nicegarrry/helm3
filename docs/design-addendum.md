Helm 3.0 Addendum

1. Purpose

This addendum extends the Helm 3 target architecture in two areas:

1. The frontier orchestrator becomes replaceable, supporting Fable or Astra as first-class alternatives.
2. Helm adopts several additional execution, handoff, permissions and observability patterns from Disler’s Super Simple Software Factory where they strengthen reliability without reducing orchestrator autonomy.

The underlying Helm 3 thesis remains unchanged:

Frontier intelligence decides how the work should be done. Deterministic software makes those decisions durable, bounded, observable and recoverable.

⸻

2. The Orchestrator Is Replaceable Compute

Helm 3 should not depend architecturally on Fable.

Instead it has one active frontier orchestrator.

Initial supported orchestrators:

Fable
→ Claude Agent SDK
→ Claude subscription capacity
Astra
→ Codex SDK
→ ChatGPT/Codex subscription capacity

Both operate the same Helm domain API.

                    HUMAN
                      │
                    BRIEF
                      │
                      ▼
              ACTIVE ORCHESTRATOR
             /                   \
          Fable                  Astra
     Claude Agent SDK         Codex SDK
             \                   /
              └──── HELM API ───┘
                       │
                       ▼
               HELM CONTROL PLANE
                       │
                       ▼
                PI WORKER FABRIC

This differs deliberately from worker abstraction.

The orchestrator runtime is replaceable.
The worker runtime remains Pi-native.

Supporting two frontier orchestrators therefore does not force Helm workers onto a lowest-common-denominator harness interface.

⸻

3. Orchestrator Driver

Helm should define a very small internal orchestrator-driver contract.

Conceptually:

start()
resume()
send_event()
invoke()
interrupt()
checkpoint()
handoff()
stop()

It exists to handle differences between:

Claude Agent SDK
Codex SDK

It should not abstract reasoning behaviour.

Both orchestrators see essentially the same Helm tools:

brief.get
map.get
map.update
map.close
models.get
budget.get
worker.spawn
worker.inspect
worker.steer
worker.fork
worker.stop
gate.run
review.request
lease.issue
lease.renew
integration.prepare
integration.merge
log.query
orchestrator.consult
human.escalate

Helm domain semantics therefore remain independent of the frontier model running them.

⸻

4. Fable and Astra Should Be Empirically Interchangeable

Helm should make the choice of primary orchestrator an operating decision rather than an architectural commitment.

A build should be runnable as:

helm run --orchestrator fable

or:

helm run --orchestrator astra

The same Brief, Map, Helm tools and Pi workers should remain available.

This creates unusually clean A/B testing.

For comparable substantial engineering objectives, measure:

accepted outcomes
time to closure
human interventions
map churn
unnecessary worker attempts
worker utilisation
review rework
autonomous recovery rate
resource consumption
orchestrator quota consumption
product-intent preservation

The question:

Which model is the better Helm orchestrator?

becomes empirically answerable.

It may also vary by problem type.

⸻

5. Orchestrator-Level Peer Cognition

A primary orchestrator should be able to invoke another frontier model as an independent thought partner.

This should become a first-class Helm capability.

Conceptually:

orchestrator.consult(
    model = astra,
    objective = "...",
    mode = independent
)

or:

orchestrator.consult(
    model = fable,
    objective = "...",
    mode = adversarial
)

The important property is independence.

The consulting model should receive the relevant problem context and evidence, but not simply inherit the primary orchestrator’s chain of conclusions.

Useful modes include:

Independent approach

Solve this problem independently before seeing my proposed solution.

Useful for difficult product-to-architecture translation.

Adversarial review

Attempt to falsify this plan and identify the strongest failure modes.

Useful before major architectural commitments.

Map review

Given the Brief and current Map, identify missing work, unnecessary work or incorrect decomposition.

Useful before committing substantial resources.

Milestone closure review

Independently assess whether this branch of the Map materially satisfies the Brief.

Useful before declaring major outcomes complete.

Decision comparison

Primary orchestrator creates A.

Peer creates B independently.

Primary sees both and adjudicates.

⸻

6. Peer Cognition Is Selective, Not a Committee

Do not turn every decision into:

Fable + Astra + Sol + reviewer
→ vote

That destroys speed and economics.

The primary orchestrator decides when additional frontier cognition is justified.

Typical use:

ordinary implementation
→ primary orchestrator only
difficult decomposition
→ independent second view
major architecture
→ adversarial frontier review
major Map closure
→ independent frontier assessment
high uncertainty
→ parallel conceptual approaches

Fusion is therefore a cognitive primitive, not a fixed workflow.

⸻

7. Primary Ownership and Split-Brain Prevention

Only one orchestrator may control a Helm run at a time.

Supporting Fable and Astra must never mean both can independently manipulate the Map simultaneously.

Introduce an Orchestrator Lease distinct from the broader Autonomy Lease.

orchestrator_lease:
owner:
  astra
session:
  ...
epoch:
  42
issued_at:
  ...
expires_at:
  ...

Every orchestrator-originated mutating command carries the current lease epoch.

Helm refuses commands from an old epoch.

This gives us fencing:

Astra owns epoch 42
Astra fails
Helm transfers ownership
Fable receives epoch 43
late Astra command from epoch 42
→ REFUSED

This becomes critical once automatic failover exists.

⸻

8. Frontier Orchestrator Failover

Because Brief, Map and Log exist outside model context, the active orchestrator should eventually be replaceable during a live build.

Example:

Astra primary
     │
     ├─ quota exhausted
     │
     └─ session/runtime failure
              ↓
     deterministic Helm detects
              ↓
       revoke Astra lease
              ↓
      prepare recovery bundle
              ↓
         start Fable
              ↓
       issue new lease epoch
              ↓
        continue factory

The reverse must also work.

Fable → Astra

⸻

9. Failover Recovery Bundle

A replacement orchestrator should not need the predecessor’s complete conversation.

Helm constructs a compact recovery package:

Brief
current Map
material decisions
active Pi workers
pending command records
recent handoffs
open findings
open gates
integration state
resource/quota state
Autonomy Lease
Needs You queue
orchestrator queue
recent material Log events

Optionally include a final summary produced by the outgoing orchestrator when graceful handoff is possible.

But correctness cannot depend on receiving one.

An orchestrator handoff improves recovery. Helm state enables recovery.

⸻

10. Failover Triggers

Some failovers can eventually be automatic.

Strong deterministic triggers:

process/runtime died
provider unavailable
session cannot resume
hard subscription quota exhausted
orchestrator lease expired without renewal

Other situations should initially remain judgement/escalation events:

orchestrator appears confused
poor plan quality
high Map churn
repeated bad decisions

Helm should not invent an algorithm that decides one frontier model has become “stupid.”

⸻

11. Cross-Provider Failover Is Particularly Valuable

The combination of Fable and Astra gives Helm provider redundancy.

Anthropic unavailable
→ Astra can continue
OpenAI unavailable
→ Fable can continue

This is structurally stronger than having both primary and backup orchestrators depend on the same provider.

It also enables deliberate resource balancing.

⸻

12. Protect Orchestrator Capacity

The Model Economy module must now track orchestrator capacity explicitly.

If Astra orchestrates through Codex while Sol Pi workers also consume the ChatGPT/Codex subscription pool:

ChatGPT pool
├── Astra orchestrator
└── Sol workers × N

workers must not consume the cognition required to operate the factory.

Likewise:

Claude pool
├── Fable orchestrator
└── optional Claude external cognition

Helm therefore maintains an orchestrator reserve per shared subscription pool.

Crossing that reserve requires human approval.

The active orchestrator cannot waive its own reserve.

This also means failover planning can consider:

primary pool nearly dry
backup provider healthy

rather than waiting for complete exhaustion.

⸻

13. Orchestrator-Level Review Is Recorded

Peer frontier cognition is never an invisible chat.

Each consultation becomes a Log object:

consultation_id
primary_orchestrator
consulting_model
provider
mode
objective
context refs
result
resource use
decision/disposition

The primary orchestrator records what it did with the result:

accepted
partially accepted
rejected
superseded

This gives Helm data over time on when frontier second opinions actually improve outcomes.

⸻

14. New Principle: Agent Proposes, Helm Disposes

Super Simple Software Factory expresses a particularly useful principle:

Agent proposes, code disposes.

Its implementation makes deterministic code responsible for sequencing, acceptance and mechanics while agents perform bounded reasoning work.

Helm should adopt half of this principle.

For Helm:

The orchestrator owns the workflow. Deterministic Helm owns the effects.

For example:

Fable:
"This implementation should now merge."
          ↓
Helm:
re-read head
re-read CI
verify review evidence
verify authority
perform merge
read result back

Or:

Astra:
"Run the acceptance test."
          ↓
Helm:
execute known deterministic gate
capture evidence
return result

What Helm should not adopt is SSSF’s stronger assumption that deterministic code owns the development graph itself.

SSSF deliberately makes code own sequencing and agents bounded nodes inside predetermined phases.

Helm’s bet is different:

Frontier orchestrators should increasingly design their own workflow.

So we steal the effect boundary, not the fixed graph.

⸻

15. Known Mechanics Should Be Code, Not Agents

SSSF makes an excellent distinction:

If the operation is already known, code should execute it rather than paying an agent to rediscover it.

Helm should apply this aggressively.

Examples:

run tests
run lint
run typecheck
inspect CI
create worktree
commit known files
calculate diff
check merge SHA
measure disk
read quota
collect git status

These are Helm operations.

Do not spawn:

tester agent
git agent
CI agent
quota agent

unless actual judgement is required.

A failing deterministic operation can be handed to a worker as evidence.

⸻

16. Structured Agent Envelopes

SSSF’s typed-envelope design is worth adopting more explicitly.

It allows an agent two output channels:

1. reference artifacts;
2. a machine-readable typed report.

The report acts as a manifest of claims, and deterministic gates verify those claims afterwards.

For Helm, every substantive Pi attempt should end with a structured result.

Example:

WorkerResult {
  status
  summary
  changed_files
  commits
  decisions
  discoveries
  tests_claimed
  acceptance_claims
  risks
  unresolved
  artifacts
  recommended_next_action
}

This is effectively the Helm handoff, but formalising it as the required terminal envelope makes it substantially more useful.

⸻

17. Claims Are Not Evidence

A powerful SSSF idea:

The envelope is a manifest of claims. Gates verify them.

Adopt this as a Helm invariant.

If a worker says:

tests passed

that is a claim.

Helm should preferably have:

GateResult:
  command
  commit SHA
  exit status
  checks performed
  evidence

Likewise:

"Changed only these three files"

can be compared against Git.

"Implemented acceptance criterion 4"

may be checked by an acceptance gate or reviewer.

This reinforces Helm’s existing distinction between model judgement and deterministic evidence.

⸻

18. Correct Near-Misses in the Same Session

SSSF does not cold-restart an agent whose JSON output is almost correct or whose gate discovers a repairable error.

It feeds the correction back into the same session, preserving the context that created the near-miss.

This maps perfectly onto Pi.

Helm should prefer:

worker
  ↓
gate fails
  ↓
steer/followup same Pi session
  ↓
repair

over:

worker
  ↓
gate fails
  ↓
throw away context
  ↓
new worker from zero

A new session should be used when independence is desirable, not merely because something needs correction.

⸻

19. Stronger Write Boundaries

SSSF distinguishes tool access from actual write authority.

A worker may technically possess shell access while still being constrained to a defined set of repository paths; unauthorized mutations are detected against repository state. It additionally protects the factory machinery that evaluates workers from being modified by those same workers.

Helm should adopt this in two layers.

Preventive

The Helm Pi extension enforces:

worker write scope
protected paths
assigned worktree
lease authority

before a tool runs.

Detective

After the attempt, Helm compares actual repository changes against authorised scope.

This catches indirect modifications through shell commands.

Important protected areas may include:

Helm control configuration
verification/gate machinery
security-sensitive policy
factory runtime
CI policy

unless the task explicitly grants permission to modify them.

This prevents a worker from quietly altering the system that will subsequently grade its work.

⸻

20. Raw Execution Record + Queryable Projection

SSSF uses a useful dual representation:

raw files are the durable execution record; SQLite is the queryable mirror used by the UI.

Helm should adapt the principle carefully.

The Helm Log remains authoritative for orchestration facts.

But Pi execution should also persist append-only raw artifacts:

Pi event stream
exact worker envelope
important prompts/context manifest
gate evidence
tool events

The SQLite Log indexes and projects them.

This has two advantages:

1. deep forensic evidence survives schema changes;
2. the query database can potentially be reconstructed from raw execution artifacts.

Do not create competing task truth.

GitHub/Map remains authoritative for work state.

The raw journal is execution evidence.

⸻

21. Rich Semantic Observability

SSSF records semantic live events such as:

agent_start
tool_call
handoff
gate_pass
gate_fail
agent_end
error

and associates usage, duration and evidence with them while the worker is still running.

Pi makes this even more natural for Helm.

Helm should capture events at approximately:

worker.started
worker.message
worker.tool.started
worker.tool.completed
worker.steered
worker.compacted
worker.envelope
worker.completed
gate.started
gate.passed
gate.failed
review.finding
review.completed
integration.started
integration.completed

The cockpit can then show meaningful execution traces without parsing terminal text.

⸻

22. Track Context Occupancy Separately From Cost

One especially useful SSSF observability idea is distinguishing:

tokens consumed over time

from:

current context-window occupancy

They answer different questions.

For long-running Pi workers and orchestrators Helm should track:

context_tokens
context_window
compaction count
tokens consumed
cached tokens
cost/resource consumption

This makes impending context degradation observable.

It also lets Helm/Fable decide whether to:

continue
compact
handoff
fork
restart fresh

based on reality.

⸻

23. Gates Should Record What They Checked

Do not store merely:

gate = pass

Store:

gate = pass
checks:
  tests: passed
  typecheck: passed
  artifact X: exists
  commit: abc123

SSSF explicitly persists the evidence inspected by a gate rather than only the final verdict.

This strengthens Helm’s evidence-bound integration model.

⸻

24. What NOT to Take From SSSF

Several design choices are good for SSSF but wrong for Helm.

Do not make deterministic code own the workflow graph

SSSF’s central thesis is:

code owns sequencing
agents occupy bounded phases

Helm instead wants:

frontier orchestrator owns sequencing
code owns durable effects + invariants

This is the most important distinction.

Do not create a fixed named agent roster

Planner / builder / reviewer / documenter are useful starter roles, but Helm should retain one flexible worker primitive.

Fable/Astra creates whatever topology the current problem warrants.

Do not create a workflow DSL or growing library of ADW scripts

Successful patterns may become skills or helpers.

They should not become mandatory workflow structure.

Do not copy the entire factory into each project

Helm should remain a shared control plane with lightweight per-repository configuration and project-specific Brief/Map context.

Avoid runtime drift between stamped copies.

⸻

25. Updated Target Architecture

                              HUMAN
                                │
                              BRIEF
                                │
                                ▼
                    ┌─────────────────────┐
                    │ ACTIVE ORCHESTRATOR │
                    │ + ownership lease   │
                    └─────────┬───────────┘
                              │
               ┌──────────────┴───────────────┐
               │                              │
              Fable                          Astra
         Claude Agent SDK                 Codex SDK
               │                              │
               └──────── HELM TOOLS ──────────┘
                              │
                  peer cognition available
                 Fable ◄────────────► Astra
                              │
                              ▼
          ┌─────────────────────────────────────┐
          │          HELM CONTROL PLANE         │
          │                                     │
          │ Brief / Map / Log                   │
          │ Command records                     │
          │ Event journal                       │
          │ Deterministic supervisor            │
          │ Reconciler                          │
          │ Autonomy leases                     │
          │ Orchestrator lease / fencing        │
          │                                     │
          │ Model Economy                       │
          │ Quota + reserves                    │
          │ Calibration                         │
          │                                     │
          │ Worktrees / permissions             │
          │ Gates / evidence                    │
          │ Handoffs / envelopes                │
          │ Integration                         │
          └──────────────────┬──────────────────┘
                             │
                     Pi-native execution
                             │
                ┌────────────▼────────────┐
                │     HELM PI RUNTIME     │
                │ Pi SDK + Helm extension │
                └────────────┬────────────┘
                             │
                ┌────────────┼─────────────┐
                ▼            ▼             ▼
              Sol          Sol         other model
            builder      reviewer        thinker
                      optional tracked
                    external cognition

⸻

26. Updated Build Sequence

The earlier Helm 3 build plan should change slightly.

Phase 0 — preserve behavioural evidence

Freeze the important Helm 2 tests, invariants and landmines.

Phase 1 — clean deterministic Helm 3 kernel

Extract/rebuild:

Brief / Map / Log
command records
ledger/events
authority/refusals
Model Economy
tracker
worktrees
gates
merge/integration

Phase 2 — Pi-native runtime

Prove native worker spawning, event streaming, steering, write permissions, envelopes and handoffs.

Phase 3 — first orchestrator driver

Implement either Fable or Astra end-to-end through the Helm tool contract.

The interface must not contain provider-specific concepts.

Phase 4 — second orchestrator driver

Implement the other frontier orchestrator early rather than leaving pluggability theoretical.

Prove the same small feature can run under both.

Phase 5 — orchestrator consultation

Implement selective independent/adversarial calls from one orchestrator to the other.

Phase 6 — supervisor + autonomy leases

Implement event-driven mechanics and expiring authority.

Phase 7 — orchestrator ownership + failover

Add orchestrator lease epochs, recovery bundles and controlled cross-provider takeover.

Phase 8 — full quality loop and cockpit

Integration, Map closure and the operational UI.

⸻

27. New Acceptance Tests

In addition to the original Helm 3 acceptance test, prove:

Orchestrator interchange

The same Brief can be executed by:

Fable → Helm → Pi

and:

Astra → Helm → Pi

without changing Helm domain behaviour.

Independent review

A primary orchestrator can request an independent frontier assessment and receive a result without contaminating the independent model with the primary conclusion first.

Failover

Mid-build:

primary orchestrator killed
→ Pi workers continue safely
→ Helm remains consistent
→ replacement reconstructs state
→ new orchestrator lease issued
→ old epoch commands refused
→ build continues

Quota failover

Primary provider becomes genuinely unavailable.

Helm preserves the active fleet, switches frontier orchestration to the alternate provider and continues without human reconstruction.

Context-pressure recovery

An orchestrator approaches context limits.

Helm can checkpoint/handoff and resume with a fresh session without losing Brief/Map/Log continuity.

⸻

28. Revised Core Invariants

Add the following to the Helm 3 invariants:

16. The frontier orchestrator is replaceable compute.

17. Exactly one orchestrator owns mutating authority at any moment.

18. Old orchestrator epochs are fenced after takeover.

19. Frontier peer review is independent by construction where independence matters.

20. Workers may propose facts; claims become trusted only through appropriate evidence.

21. Repairable near-misses should normally preserve the worker’s useful context rather than cold-starting.

22. Workers cannot silently modify the machinery that evaluates or controls them.

23. Context occupancy is an operational resource distinct from token spend.

⸻

29. Final Strategic Position

Helm 3 now separates intelligence into three levels:

FRONTIER ORCHESTRATION
Fable or Astra
strategy / judgement / allocation / closure
        ↓
WORKER COGNITION
Pi + Sol / other models
implementation / investigation / review
        ↓
DETERMINISTIC COMPUTATION
Helm
state / execution / verification / authority / economics

A second frontier orchestrator provides:

independent thought
adversarial review
provider redundancy
failover

without becoming a second concurrent controller.

The resulting architecture makes a stronger long-term bet:

The frontier model is not part of Helm’s durable identity.

Fable may be best today.

Astra may be best tomorrow.

A future model may outperform both.

Helm survives all of them.

The durable asset is:

Brief + Map + Log + evidence + execution primitives + the accumulated empirical knowledge of how to deploy intelligence effectively.
