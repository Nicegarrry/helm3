Helm 3.0

1. Purpose

Helm 3.0 is an autonomous software-development system for long-running, multi-agent engineering.

It should allow a human to give high-level product and engineering direction, then delegate execution for many hours or days to a frontier orchestrator that can dynamically plan, build, review, recover and adapt.

The core objective is:

Maximise high-quality engineering progress between meaningful human interventions.

Helm is not primarily a workflow engine, coding-agent wrapper or agent dashboard.

It is a durable control plane for frontier-model software development.

Its fundamental design principle is:

Models exercise judgement. Deterministic machinery provides memory, execution, evidence, constraints and recovery.

⸻

2. Strategic Bet

Helm 3 is designed for models substantially more capable than today’s.

Future Fable/Astra/GPT-class models should be able to decide:

* how to decompose an objective;
* how many workers to use;
* whether parallel approaches are useful;
* which model is best for each task;
* whether additional review is worthwhile;
* when to change architecture or plan;
* when to ask another frontier model for an opinion;
* how much cognition is justified by the importance of a problem;
* when a map branch is genuinely complete.

Helm therefore should not encode today’s preferred development workflow.

Instead it provides a compact set of powerful primitives from which the orchestrator can construct the workflow needed for the current problem.

The system should become less prescriptive as models improve.

⸻

3. Human Mental Model: Brief / Map / Log

Helm 3 preserves the strongest conceptual model from Helm 2.

Brief — what matters

The Brief contains the durable human contract:

* intended outcome;
* target users;
* examples;
* priorities;
* quality expectations;
* fixed requirements;
* delegated authority;
* resource constraints;
* escalation conditions;
* completion evidence.

The Brief should remain short and understandable.

Fable may propose changes to it.

Fable may not silently rewrite it.

⸻

Map — our current approach

The Map represents Fable’s current understanding of how to achieve the Brief.

It may contain:

* outcomes;
* capabilities;
* architectural decisions;
* investigations;
* implementation issues;
* dependencies;
* gates;
* milestones;
* unresolved questions.

Unlike the Brief, the Map is deliberately fluid.

Fable may reorganise, split, merge, add or remove work as it learns.

The Map is a plan, not a fixed workflow.

⸻

Log — what actually happened

The Log is the durable record of execution and learning:

* attempts;
* model choices;
* costs;
* events;
* decisions;
* failures;
* findings;
* handoffs;
* evidence;
* merges;
* quota events;
* human rulings.

Agents can disappear.

Their important work cannot.

⸻

4. Target User Experience

The desired operating model is:

Human
   │
   │ strategic/product direction
   ▼
BRIEF
   │
   ▼
Fable
Frontier Orchestrator
   │
   ├─ evolves Map
   ├─ allocates cognition
   ├─ creates work
   ├─ supervises exceptions
   └─ closes outcomes
   │
   ▼
Helm Control Plane
   │
   ├─ makes decisions executable
   ├─ preserves state
   ├─ enforces authority
   ├─ monitors execution
   └─ gathers evidence
   │
   ▼
Pi-native Worker Fabric
   │
   ├─ Sol builders
   ├─ Sol reviewers
   ├─ alternative-model thinkers
   └─ specialised agents

A human should be able to say:

Build Instagram sharing into the capture system so useful shared content becomes properly represented in the wiki.

Fable should be capable of autonomously:

understand product intent
        ↓
inspect product + code + map
        ↓
identify uncertainty
        ↓
seek independent thinking if useful
        ↓
change the map
        ↓
write acceptance conditions
        ↓
allocate workers
        ↓
supervise execution
        ↓
review / test / repair
        ↓
integrate
        ↓
validate against original intent
        ↓
close map branch
        ↓
report outcome

The human should not manage individual workers.

⸻

5. Target Architecture

                         HUMAN
                           │
                         BRIEF
                           │
                           ▼
              ┌────────────────────────┐
              │ FABLE                  │
              │ Claude Agent SDK       │
              │                        │
              │ strategic judgement    │
              └───────────┬────────────┘
                          │
                    typed Helm tools
                          │
       ┌──────────────────▼───────────────────┐
       │          HELM CONTROL PLANE          │
       │                                      │
       │ Brief / Map / Log                    │
       │                                      │
       │ Command Planning + Execution         │
       │ Events + Attempts                    │
       │ Supervisor + Reconciler              │
       │ Autonomy Leases                      │
       │                                      │
       │ Model Economy                        │
       │ Worktrees                            │
       │ Verification                         │
       │ Handoffs                             │
       │ Review                               │
       │ Integration                          │
       └──────────────────┬───────────────────┘
                          │
                    native Pi control
                          │
               ┌──────────▼──────────┐
               │ HELM PI RUNTIME     │
               │ Pi Agent SDK        │
               │ + Helm extension    │
               └──────────┬──────────┘
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
        Sol             Sol           other model
      builder         reviewer          thinker
              tracked external cognition
                 Claude / other tools
       ┌──────────────────────────────────┐
       │ CLI            Local Web Cockpit │
       └──────── same Helm API ───────────┘

⸻

6. Fable Orchestrator

Technology: Claude Agent SDK.

Fable is the top-level judgement engine.

It is not merely an interactive Claude Code session being automated.

It is a first-class Helm component with typed access to Helm capabilities.

Responsibilities include:

* interpret human intent;
* create and modify the Map;
* understand dependencies;
* decide task size;
* choose worker topology;
* choose models;
* issue autonomy leases;
* decide whether review is needed;
* synthesise competing approaches;
* respond to failures;
* adjudicate findings;
* decide when integration should occur;
* determine conceptual closure;
* escalate genuine decisions.

Fable should not perform routine polling.

The deterministic supervisor wakes it when judgement is required.

⸻

7. Helm Tool Surface

The tool surface should be deliberately small and deep.

Illustrative primitives:

brief.get
brief.propose_change
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
integration.prepare
integration.merge
lease.issue
lease.renew
log.query
human.escalate

Avoid building dozens of workflow-specific commands.

Fable should compose primitives into workflows.

⸻

8. Command Planning and Execution

A key Helm 2 pattern becomes a general Helm 3 architecture.

Every consequential action should separate:

INTENT
  ↓
PLAN
  ↓
VALIDATED COMMAND RECORD
  ↓
EXECUTION
  ↓
OBSERVED RESULT

For example:

SpawnWorkerCommand
RunGateCommand
MergeCommand
CloseMapNodeCommand
RequestReviewCommand

Planning is ideally pure:

requested action
+ configuration
+ freshly observed facts
        ↓
validated immutable command

Execution consumes the validated command and performs effects.

Benefits:

* auditability;
* durable queueing;
* crash recovery;
* replay protection;
* testability;
* clear refusal semantics;
* separation of judgement from mechanism.

The current dispatch implementation already proves this pattern works well.

⸻

9. Authority and Sources of Truth

Helm should not create one giant database and declare itself the truth about everything.

Use the authoritative system closest to each fact.

Brief

Authoritative human intent.

Stored in a durable, human-readable representation.

Map

Initially represented primarily through GitHub issues, relationships and Helm metadata.

GitHub remains authoritative for issue/PR state.

Repository reality

Git/GitHub/CI remain authoritative for:

* commits;
* branches;
* PR heads;
* merge status;
* CI results.

Pi

Authoritative for live native worker/session execution state.

Helm Log

Authoritative for orchestration history:

* attempts;
* model choices;
* resource consumption;
* leases;
* events;
* decisions;
* findings;
* handoffs.

UI projections

Never authoritative.

Helm preserves the existing rule:

Remember for showing; ask fresh for doing.

Cached state may power the cockpit.

Any action that changes the world must re-read the facts required to authorise that action.

The current Helm ledger deliberately makes display projections disposable and requires mutating actions to re-read external reality.

⸻

10. Event Log and Attempts

Helm should retain the existing SQLite ledger concept and evolve it.

Core objects include:

attempt
event
action
finding
handoff
quota observation
resource reading
autonomy lease
human decision
command record

Attempts retain historical facts even when configuration later changes:

task / map node
role
model
family
capability tier
resource pool
session
worktree
commit
start/end
outcome
tokens
cost
findings
evidence

This becomes the empirical base for improving the factory.

⸻

11. Deterministic Supervisor

The supervisor runs continuously without a model in the loop.

It performs only transitions for which there is clearly one sensible action.

Examples:

worker died transiently
→ retry within lease
quota exhausted
→ block until reset
PR ready for required review
→ launch review if lease allows
gate finished
→ record result
meaningful exception
→ wake Fable

It should not continuously ask Fable whether something happened.

The existing Helm design correctly separates a continuously running deterministic supervisor from an intermittently awakened Fable.

The supervisor also drives the deterministic status projection used by the frontend.

⸻

12. Autonomy Lease

The existing Helm supervisor mandate becomes a core Helm 3 primitive and is renamed Autonomy Lease.

Fable issues a lease giving the deterministic system bounded authority.

Example:

scope:
  map_branch: instagram-ingestion
authority:
  dispatch
  retry
  review
  run-gates
resource_limits:
  chatgpt: ...
  claude: ...
  go: ...
max_concurrency: 12
max_attempts_per_node: 4
expires_at:
  2026-09-16T06:00

The supervisor may act only within the lease.

Hard Helm safety/correctness rules sit outside it and cannot be authorised away.

Expiry

Every lease expires.

When it expires:

monitoring continues
status continues
evidence collection continues
new spending stops

Fable must renew the lease.

This acts as a dead-man switch.

The current design already recognises that an autonomous supervisor must stop spending if the orchestrator dies or stops renewing authority.

This is fundamental to safe long-duration operation.

⸻

13. Model Economy

The existing Helm cost/quota system should be retained and elevated to a first-class subsystem.

Its job is not to choose models.

Its job is to give Fable an accurate compressed view of resource reality and enforce the few limits that genuinely require deterministic enforcement.

Model Registry

Each model carries facts such as:

model
provider/family
Pi provider
build capability tier
review capability tier
resource pool
availability
roles
data-policy properties
observed performance

Build and review capability may differ.

A model can be an excellent reviewer without being an equivalent builder.

⸻

Resource Pools

Pools may differ economically.

Examples:

ChatGPT subscription capacity
Claude subscription capacity
dollar top-up pool
API spend pool

Do not flatten all pools into dollars.

Unused subscription allowance and incremental API spend are economically different.

⸻

Quota Monitor

Track where technically possible:

remaining headroom
reset time
recent usage
known quota events
concurrency/rate limits

Unknown must remain unknown.

Never manufacture a reassuring number because a provider does not expose one.

⸻

Budget Ledger

Record actual consumption from each attempt.

Track:

today
rolling windows
per model
per pool
per task
per map branch
per accepted outcome

⸻

Calibration

Routing quality should improve from evidence.

Useful metrics include:

completion rate
cost per accepted task
review rounds
confirmed findings
overruled findings
repair rate
latency
human intervention

No deterministic algorithm should automatically re-tier models from a few metrics.

Fable interprets the evidence.

⸻

14. Model Routing Philosophy

The existing routing decision should survive almost unchanged:

Helm supplies the picture. Fable chooses. Helm refuses illegal choices.

The current design explicitly rejected deterministic routing in favour of giving the orchestrator model capability, pool and pacing information while retaining a few hard refusals.

Guidance:

Use the best affordable cognition appropriate to the importance of the work—not automatically the cheapest model.

Fable should trade:

* capability;
* latency;
* available quota;
* critical-path status;
* review independence;
* observed model performance;
* monetary cost.

⸻

15. Refusal Classes

Helm should retain a small number of deterministic refusals.

Correctness/policy refusals

Not overridable by Fable:

* model below required seam/capability floor;
* prohibited data-policy model;
* disabled model;
* worker lacks required role capability;
* same session builds and independently reviews;
* required independent review is not independent;
* required machine oracle absent;
* write outside assigned workspace;
* operation exceeds delegated authority.

Resource refusals

Potentially overrideable only through the appropriate authority path:

* concurrency cap;
* discretionary budget target;
* disk floor;
* top-up spending threshold.

Physical/provider constraints

Not meaningfully overrideable:

* subscription quota exhausted;
* rate limit;
* unavailable provider.

Orchestrator reserve

A shared resource pool used by Fable must preserve enough capacity for orchestration.

Workers must not accidentally consume the cognition required to operate the factory.

Crossing the orchestrator reserve should require human approval, not Fable self-approval.

⸻

16. Pi-Native Worker Runtime

This is Helm 3’s major architectural departure from the current CLI.

Pi becomes an architectural dependency.

Helm uses:

* Pi Agent SDK;
* custom Helm Pi extension.

A worker is not an opaque subprocess.

Helm owns a live Pi session.

Native capabilities should include:

create
steer
follow-up
pause
resume
fork
change model
subscribe to events
control tools
inject context
compact
checkpoint
terminate

The custom Helm Pi extension should enforce runtime invariants inside the agent loop.

Example:

model requests edit()
      ↓
Helm extension
      ↓
check:
  lease valid?
  correct worktree?
  node active?
  worker owns write scope?
  path permitted?
      ↓
execute / refuse

⸻

17. One Worker Primitive

Avoid rigid agent classes.

The fundamental object is:

spawn(
  objective,
  model,
  workspace,
  context,
  tools,
  permissions,
  acceptance
)

Intent may be labelled:

implement
investigate
review
design
verify
adversarial-review

but these are behaviours, not separate runtime architectures.

A reviewer is a Pi agent with:

* independent context;
* read-only permissions where appropriate;
* a review objective;
* evidence requirements.

⸻

18. Worktrees and Isolation

Each writing worker gets an isolated worktree.

repository
 ├── worktree A → worker A
 ├── worktree B → worker B
 ├── worktree C → worker C
 └── detached review worktree

Invariant:

One writer per worktree, not one writer globally.

This allows high parallelism while keeping writes understandable.

Worktree state is first-class Helm state.

Failed worktrees remain available for inspection until deliberately reclaimed.

⸻

19. Context Manager

Helm should actively control context rather than forwarding entire histories.

Worker context should contain only what helps its objective:

objective
acceptance criteria
relevant Brief excerpts
relevant Map branch
architectural decisions
dependency handoffs
relevant code information

Avoid automatically including:

all worker transcripts
entire Map
all historical decisions
orchestrator chatter

Pi-native context hooks and compaction should be used.

⸻

20. Handoffs

Every substantial attempt produces a structured handoff.

Core fields:

summary
changes
commits
tests
acceptance evidence
decisions
discoveries
risks
open questions
recommended next action

Handoffs are durable context compression.

They feed:

* Fable;
* reviewers;
* dependent workers;
* recovery;
* Map closure.

The existing Helm handoff principle—mechanical facts generated deterministically rather than reconstructed from memory—should be preserved.

⸻

21. Verification and Gates

Helm separates model judgement from machine evidence.

Possible gates:

tests
typecheck
lint
build
static analysis
API contract
UI/screenshot checks
migration checks
custom acceptance scripts

Where useful:

define acceptance
      ↓
prove gate currently RED
      ↓
implement
      ↓
prove GREEN

The orchestrator decides when gate-first development is worthwhile.

⸻

22. Review and Cognitive Escalation

Review depth should be chosen dynamically.

Possible patterns:

simple
→ Sol build
normal
→ Sol build
→ Sol independent review
ambiguous
→ two independent approaches
→ Fable synthesis
high risk
→ implementation
→ independent review
→ adversarial review
major milestone
→ multi-part evidence
→ frontier conceptual review
→ Fable closure

Multi-model reasoning is a capability, not a mandatory pipeline.

Potential cognitive primitives:

ask_independent
compare
challenge
adversarial_review
alternative_plan

⸻

23. Integration

Helm owns integration mechanics.

Workers should normally not merge their own work into the target branch.

Integration should verify fresh world state immediately before any irreversible operation.

The existing Helm merge protocol is a model worth retaining:

* exact expected head SHA;
* mergeability;
* CI on that SHA;
* trusted independent approval tied to that SHA;
* execute merge;
* read back resulting state.

The current implementation already applies this evidence-bound approach rather than trusting stale approval state.

General rule:

Every irreversible action is evidence-bound to the exact world state it was authorised against, and success is confirmed by observing the resulting world state.

⸻

24. External Cognition

Pi is the native worker runtime.

However Helm may selectively invoke external cognition when valuable.

Examples:

Claude
specialised external agent
future model/harness

External agents do not receive full Pi worker semantics.

They may have a narrow contract:

run
cancel
result

But they are never off-ledger.

Helm records:

objective
model
family
resource pool
usage
outcome
findings

This preserves:

* cost accounting;
* review provenance;
* independence checks;
* model calibration.

⸻

25. Deterministic Reconciler

Helm must recover from process death and stale state.

Periodically and on restart it compares:

recorded desired state
          ↕
actual Pi sessions
actual processes
actual Git/worktrees
actual GitHub/CI state

Examples:

worker recorded active but session dead
worktree exists without live attempt
PR merged but Map not updated
completed worker missing handoff
expired autonomy lease
integration interrupted

Repair safe mismatches automatically.

Queue judgement for Fable where repair is ambiguous.

⸻

26. Frontend: Helm Cockpit

The frontend should be brought forward in Helm 3 rather than treated as polish.

It is not primarily an agent dashboard.

It is the operator’s view of the software factory.

Primary screen:

HELM
Sidekick PA
Outcome: Instagram → Wiki ingestion
MAP
████████████████░░░░ 78%
ACTIVE
12 workers
3 reviews
1 blocked
NEEDS YOU
1 decision
MODEL ECONOMY
Sol        64% available
Claude     81% available
Go         $8.40 / $30
RECENT
✓ Share extension integrated
✓ ingestion tests green
● metadata review underway
! carousel behaviour needs ruling

Primary navigation:

Overview
Map
Needs You
Workers
Models
Log

Worker transcripts are drill-down debugging evidence.

They are not the main product.

⸻

27. CLI and Cockpit

CLI and web UI must be equal clients of the same Helm core.

Neither contains independent orchestration logic.

            Helm Core
            /       \
          CLI       Web

Anything shown in the frontend must be reproducible through a machine-readable Helm API.

Interpretive Fable commentary may be displayed separately, but never confused with authoritative state.

⸻

28. Human Escalation

Two queues should remain conceptually distinct.

Orchestrator queue

For Fable:

* worker stalls;
* second failures;
* architectural conflicts;
* stale evidence;
* difficult merge conflicts;
* review disagreement;
* plan changes.

Human queue

For the user only:

* product intent ambiguity;
* spending beyond delegated authority;
* changing fixed Brief requirements;
* high-impact risk;
* genuinely stuck decisions.

Normal engineering problems should not reach the human.

⸻

29. What Helm 3 Does Not Encode

Do not build:

* a workflow DSL;
* a fixed worker-reviewer pipeline;
* large agent taxonomies;
* deterministic model-selection trees;
* generic harness portability as a primary abstraction;
* a giant central state machine;
* terminal scraping when Pi exposes semantic events;
* separate model-generated dashboards;
* orchestration knowledge duplicated across prompts and code.

Prefer:

few concepts + deep primitives + durable evidence + strong models

⸻

30. What We Keep from the Existing Helm CLI

Preserve behaviour and, where clean, implementation for:

model registry
model calibration
pool/budget accounting
quota observations
routing refusals
GitHub tracker integration
ledger
attempt history
structured output envelopes
worktree safety
gates/checks
tamper detection
merge protocol
handoff generation
resource reclamation
fresh-read-before-action semantics

These are valuable deterministic kernel components.

⸻

31. What We Replace

Replace the current worker execution architecture:

Herdr
provider subprocess adapters
terminal lifecycle inference
CLI-specific session handling
prompt-file orchestration
provider-stream normalisation as the main worker abstraction

with:

Pi Agent SDK
+ Helm Pi Extension
+ native semantic worker events

Herdr may remain temporarily as a compatibility/observability lane during migration, but it is not part of the long-term core worker architecture.

⸻

32. What We Add

New Helm 3 capabilities:

Claude Agent SDK Fable process
Pi-native runtime
Helm Pi extension
first-class Autonomy Leases
typed orchestrator tool API
durable command records
Pi session steering/forking
context management
event-driven Fable wakeups
Map-aware closure
Helm cockpit

⸻

33. Rebuild Strategy

Helm 3 should be a clean architectural rebuild inside the existing project, not an incremental patch pile and not a blank-slate repository.

The principle:

Port behaviours, not accidental architecture.

Keep the private Helm repository and its history.

Treat the existing tests and documented landmines as a behavioural specification.

Create clean Helm 3 module boundaries rather than forcing Pi and Agent SDK into the current adapter architecture.

A possible target structure:

helm/
├── core/
│   ├── commands/
│   ├── events/
│   ├── ledger/
│   ├── authority/
│   └── reconciliation/
│
├── orchestrator/
│   ├── fable/
│   └── tools/
│
├── map/
│
├── economy/
│   ├── models/
│   ├── quota/
│   ├── budget/
│   └── calibration/
│
├── runtime/
│   └── pi/
│       ├── sessions/
│       ├── extension/
│       ├── context/
│       └── events/
│
├── workspace/
│
├── verification/
│
├── review/
│
├── integration/
│
├── tracker/
│
├── cli/
│
├── web/
│
└── legacy/
    ├── subprocess/
    └── herdr/

The exact directory layout is secondary.

The important point is a clean dependency graph.

⸻

34. Migration Sequence

Phase 0 — Freeze Helm 2 behaviour

Before architecture work:

* preserve current tests;
* classify tests as behavioural vs implementation-specific;
* freeze key invariants;
* document Helm 3 deltas.

The existing suite becomes the regression oracle.

⸻

Phase 1 — Extract the deterministic kernel

Create clean Helm 3 interfaces around:

ledger
tracker
model economy
authority/refusals
worktrees
merge
gates
output/events

Prefer reusing good code where it already matches the target architecture.

Rewrite only when existing structure creates coupling.

⸻

Phase 2 — Pi vertical slice

Prove:

Helm
→ create worktree
→ create Pi session
→ Sol worker
→ native events
→ implementation
→ structured handoff
→ shutdown

No Fable autonomy yet.

This is the critical architectural test.

⸻

Phase 3 — Fable Agent SDK

Add:

Fable
→ typed Helm tools
→ issue/map understanding
→ worker dispatch
→ inspect results
→ issue next action

Prove that Fable can run a small feature without Claude Code acting as the runtime shell.

⸻

Phase 4 — Supervisor + Autonomy Lease

Implement the deterministic watcher around the new Pi event system.

Prove:

* quiet system causes no unnecessary Fable wakeups;
* retry occurs within lease;
* lease expiry stops spend;
* restart reconstructs live state.

⸻

Phase 5 — Full quality loop

Add:

gates
review
repair
integration
map closure

Run real engineering work end-to-end.

⸻

Phase 6 — Model Economy integration

Wire the existing quota and model-calibration subsystem into Fable.

Fable should receive one compact resource view and dynamically choose models.

⸻

Phase 7 — Cockpit

Build the basic local UI over the same control-plane projections.

⸻

Phase 8 — Retire legacy worker execution

Once Pi-native operation has proven reliable:

disable Herdr path by default
retain temporary fallback
remove obsolete adapter complexity

Do not carry legacy abstractions indefinitely.

⸻

35. Initial Helm 3 Acceptance Test

The first serious test should be a real feature, not unit-test completion.

The scenario must include:

* human defines outcome;
* Fable modifies the Map;
* at least three parallel Pi workers;
* Fable chooses models with resource information;
* one worker fails;
* supervisor recovers or surfaces it correctly;
* at least one independent review;
* one implementation requires repair;
* exact evidence-bound merge;
* Fable process restarts mid-run;
* Helm reconstructs state;
* Autonomy Lease expires or renews correctly;
* final Map state matches repository reality;
* UI correctly represents the run.

Success means the human does not have to reconstruct or manually shepherd the project.

⸻

36. Success Metrics

Primary metric:

Accepted engineering progress per meaningful human intervention.

Supporting metrics:

accepted map nodes / human intervention
accepted tickets / orchestrator token
cost per accepted ticket
time to accepted outcome
review repair rounds
worker recovery rate
quota-related lost time
Fable wakeups with no useful decision
percentage of failures resolved without human involvement
percentage of actions with reproducible evidence

Agent count is not success.

Token volume is not success.

Autonomy without accepted output is not success.

⸻

37. Target Autonomy Levels

Issue autonomy

Human specifies an issue.

Fable takes it to accepted integration.

Feature autonomy

Human gives feature intent.

Fable creates and changes the Map, executes and closes it.

Outcome autonomy

Human specifies a product outcome and boundaries.

Fable:

* discovers the path;
* changes architecture if required;
* creates work;
* performs experiments;
* allocates models;
* reviews;
* integrates;
* revises the Map as evidence changes;
* returns when the desired outcome is materially achieved or genuinely blocked.

Outcome autonomy is Helm 3’s target state.

⸻

38. Core Invariants

1. The human owns the Brief.
2. Fable owns the Map within the Brief.
3. Reality is re-read before world-changing actions.
4. Agents are disposable; evidence is durable.
5. Fable chooses models; Helm exposes reality and refuses invalid choices.
6. Pi is the native worker runtime.
7. One writer owns one worktree.
8. The supervisor handles mechanics; Fable handles judgement.
9. Autonomous authority expires.
10. Unknown resource state remains unknown.
11. Irreversible operations bind to exact evidence.
12. UI projections never become authority.
13. External cognition is tracked even when it is not Pi-native.
14. No deterministic workflow exists merely because today’s models benefit from it.
15. Every piece of complexity must justify why a capable future orchestrator cannot handle it itself.

⸻

39. The Helm 3 Thesis

Helm 3 combines four things:

Fable supplies judgement.

Helm supplies durability, economics, authority and evidence.

Pi supplies deeply programmable agent execution.

The Brief / Map / Log preserve shared understanding between human and machine.

The system should provide enough deterministic structure that autonomous development is reliable, but not so much that the software itself becomes the limiting intelligence.

That is the architectural bet:

Build the control plane for models that can increasingly design their own way of working.
