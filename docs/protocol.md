# Proposed minimum protocol, revision 1

This is a reviewable interface proposal, not a shipped API or approved implementation. It defines the seams independently of the predecessor. Field spellings may change together before the contract freeze; semantics must not drift independently across workers. All timestamps are UTC RFC3339; IDs are opaque; hashes identify exact immutable bytes. Credentials never appear in these records.

## Command and observation

```typescript
type Command = {
  schemaVersion: 1;
  commandId: string;
  kind: string;                    // small typed discriminated union at implementation
  idempotencyKey: string;          // unique with scope + kind; same key/different payload refuses
  payloadHash: string;
  scope: { repositoryId: string; mapNodeId?: string };
  actorId: string;
  runId: string;
  origin: 'orchestrator' | 'supervisor' | 'worker' | 'human';
  leaseId: string;
  leaseRevision: number;
  orchestratorLeaseId?: string;
  orchestratorEpoch?: number;     // mandatory for orchestrator-originated mutation
  plannedAt: string;
  notAfter: string;
  expected: Precondition[];
  payload: unknown;                // kind-specific schema required, never arbitrary shell authority
  requiredEvidence: string[];
};
type Precondition = {
  authority: 'brief' | 'github' | 'git' | 'ci' | 'pi' | 'helm';
  subject: string;
  version?: string;                // exact SHA, node revision, lease revision, session identity
  predicate: string;
};
type Observation<T> = {
  value: T | null;
  state: 'known' | 'unknown' | 'unavailable';
  source: string;
  observedAt: string;
  subjectVersion?: string;
  reason?: string;
};
```

Pure planning consumes an explicit fact set. Validation never makes a stale plan permanently authoritative. An executor checks expiry/revocation/ownership and reads the relevant external preconditions again immediately before effects. Each kind has its own schema, freshness rule, executor and reconciliation rule. Time-sensitive capability/usage observations are never accepted merely because a UI cached them.

Immutable command bytes and append-only execution events are separate. Per-command execution may move `queued -> claimed -> effect_started -> observing -> succeeded|refused|failed|unknown`. `cancel_requested` is an event, not proof of cancellation. Executor claims carry an expiring claim token and monotonic fencing generation; an old claimant cannot continue after ownership transfer. Use local database transactions for reservations/claims and effect-specific external identity for crash recovery. Do not claim distributed exactly-once execution.

Persist intent before the effect. A crash after `effect_started` yields an unknown outcome. Observe external identity first: attempt/session ID for spawn, check-run identity for gates, PR/head identity for merge. Reconcile already-completed effects to success. Retry only when absence is established and authority still allows it. Where absence cannot be proved, retain unknown and wake the active orchestrator. Immutable commands never mutate into a new instruction; changed intent produces a new linked command.

## Lease and spending boundary

```typescript
type Lease = {
  leaseId: string;
  revision: number;
  issuedBy: string;
  parentAuthorityId: string;        // human-approved delegation chain
  scope: { repositoryId: string; mapNodeIds: string[] };
  allowedActions: string[];
  issuedAt: string;
  expiresAt: string;
  maxConcurrency: number;
  maxAttemptsPerNode: number;
  poolLimits: { poolId: string; unit: string; limit: number }[];
  protectedReserves: { poolId: string; unit: string; amount: number }[];
};
```

```typescript
type OrchestratorLease = {
  runId: string;
  leaseId: string;
  owner: 'fable' | 'astra';
  sessionId: string;
  epoch: number;
  issuedAt: string;
  expiresAt: string;
};
```

Validation fences the orchestrator lease at queue, claim and immediately before
effect. An epoch mismatch refuses and is never retried under a new epoch.
`AutonomyLease` remains the separate authority/spend boundary; supervisor work
with valid independent authority can continue after a takeover. First-wave work
persists these fields and refusal semantics, not automatic failover.

Revocation is a durable event and takes priority over expiry. Renewal creates an attributable revision and rechecks its parent authority; Neither orchestrator can enlarge human delegation or authorise reserve consumption. A human may approve a declared discretionary limit override; physical/provider constraints and hard correctness rules remain non-overridable.

Reserve capacity atomically before billable requests, retries, forks that generate summaries, compaction, model probes, reviews and external cognition. Accounting distinguishes observed actual usage from reserved upper bounds and unknown final consumption. Never silently convert token quotas to dollars. If a hard pool cap cannot be enforced because a worst-case bound is unknown, refuse that spend; expose the reason for an authority decision.

Expiry prevents new billable requests and new tool effects, including autonomous follow-ups within a still-running SDK session. Request cancellation of in-flight requests/processes, collect final usage when available, and record any unknown usage. Remote cancellation cannot guarantee zero subsequent provider charge: reserve the possible in-flight amount beforehand. Monotonic elapsed time plus conservative wall-clock revalidation prevents local clock rollback from extending a lease. Monitoring and result collection remain allowed after expiry.

## Events, attempts and sessions

Event minimum: `eventId`, `schemaVersion`, `kind`, `source`, `sourceEventId`, `occurredAt`, `recordedAt`, `commandId?`, `attemptId?`, `sessionId?`, `correlationId`, `causationId?`, `payload`. Semantic kinds include worker/tool/gate/review/integration start/completion, steering, compaction and envelopes. Enforce deduplication by source identity; do not assume remote clocks or delivery order establish causality. A durable per-consumer cursor and idempotent handler make projection rebuild and wake replay safe.

Attempt minimum: `attemptId`, Map node/revision, objective/acceptance version, role label, initial model/family/capability/pool snapshot, workspace/base SHA, context manifest hash, lease ID, session IDs, start/end observations, outcome, usage records, findings, evidence IDs and handoff ID. A model change is a new attributable segment; it never rewrites historical model/family/cost facts. Usage retains provider/pool/consumer provenance, context tokens/window, compaction count, consumed/cached tokens and cost/unknown status. Review independence checks all relevant contributing segments, not just the last selected model.

Worktree ownership is a separate fenced record: repository, canonical path, allowed write roots, branch/base SHA, attempt owner, generation and expiry. Process PID alone is not a session identity. SDK session continuation must re-establish live ownership before work; a persisted transcript is not proof the original process survived.

## Integration certificate

`IntegrationPrepare` returns an immutable certificate containing repository/PR, exact expected head SHA, target branch and observed base SHA, merge method, required checks and conclusion identities, required independent review/evidence identities, acceptance version, lease revision, preparation time and expiry. Revalidate all mutable preconditions at merge time. Head changes invalidate head-bound evidence. Target/base changes re-evaluate mergeability and every base-sensitive oracle; do not quietly reuse a test against another base.

Use the provider's exact-head compare-and-merge facility where available. A local read followed by an unconditional merge is insufficient. If target-branch freshness cannot be made atomic with the required integration policy, use branch protection/merge queue or an equivalent conditional integration lane and record its guarantees. After ambiguous API failure, read actual PR/commit state before retrying. Success requires observed resulting merge SHA and target ancestry. Map closure is a separate evidence-bound command.

## Active orchestrator and client seams

Typed Helm tools call the same application service as CLI and cockpit. The initial transport proposal is a local authenticated loopback API with machine-readable envelopes; no public listener by default. Read APIs expose observation provenance and freshness. Mutating APIs accept command intent and return command IDs; clients cannot supply trusted review approval or lease authority merely by populating fields.

Orchestrator wake records contain reason IDs, affected scope, evidence references and a deduplication key. Claim one wake batch per scope; persist consumed reasons and new commands before acknowledging. Coalesce repeated no-change observations, retain materially new evidence, and do not wake a model for routine polling. Orchestrator restarts recover from the durable queue and Brief/Map/Log, not only an SDK transcript. Human decisions use a separate queue and authenticated human ruling.

The public tool surface remains the small set in source section 7; kinds compose different workflows. Required review may be launched deterministically only when the requirement already exists and the lease permits it. These local object lifecycles do not prescribe one global engineering state machine.

## Containment proposal

Candidate for the initial macOS host: Pi tools wrapped by the upstream sandbox-runtime integration, with an allowlist of the assigned canonical workspace and dedicated temporary/cache locations. Keep GitHub mutation credentials and Helm database authority outside worker access. Deny other write roots, control child-process inheritance and network destinations, and prevent write-through symlinks or access to sibling worktrees. Read-only review sessions cannot obtain shell write authority.

This candidate is not accepted as a security boundary until its real OS-backed oracle passes: allowed write succeeds, direct/shell/subprocess/symlink writes outside scope fail, review write fails, expired lease refuses subsequent effects, and child cleanup is observed. If the host/runtime cannot enforce this, the first build decision is a supported Linux/container execution lane or narrower tools—not a prompt that claims isolation. SDK interception and local mock tests alone do not prove containment.


## Addendum schemas and recovery semantics

The optional-looking epoch fields above are mandatory when `origin` is `orchestrator`; the implementation must enforce that discriminator structurally and at the trusted command boundary. Resolve actor identity from authenticated runtime/session ownership, never from model-supplied field values. Enforce one current ownership record per run, atomic compare-and-swap acquisition, and epochs that never reset on restart. A takeover cannot make an old command valid by swapping its epoch: the new owner may create a linked, freshly planned command after reconciliation.

```typescript
type OrchestratorDriver = {
  start(input: { runId: string; contextRefs: string[]; mode: 'primary' | 'consultant' }): Promise<{ sessionId: string }>;
  resume(input: { sessionId?: string; recoveryBundleRef: string }): Promise<{ sessionId: string }>;
  send_event(input: { sessionId: string; eventRef: string }): Promise<void>;
  invoke(input: { sessionId: string; objectiveRef: string; contextRefs: string[] }): Promise<{ resultRef: string }>;
  interrupt(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }>;
  checkpoint(input: { sessionId: string }): Promise<{ bundleRef: string }>;
  handoff(input: { sessionId: string }): Promise<{ bundleRef: string; outgoingSummaryRef?: string }>;
  stop(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }>;
};
type WorkerResult = {
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  summary: string;
  changed_files: string[];
  commits: string[];
  decisions: string[];
  discoveries: string[];
  tests_claimed: string[];
  acceptance_claims: { criterionId: string; claim: string; evidenceRefs: string[] }[];
  risks: string[];
  unresolved: string[];
  artifacts: { ref: string; hash: string; mediaType: string }[];
  recommended_next_action: string;
};
type GateResult = {
  gateId: string;
  trustedDefinitionRef: string;
  definitionHash: string;
  command: string[];
  repositoryId: string;
  headSha: string;
  baseSha?: string;
  exitStatus: number | null;
  checks: { name: string; result: 'pass' | 'fail' | 'unknown'; evidenceRefs: string[] }[];
  artifactRefs: string[];
  observedAt: string;
};
```

These are proposed Helm contracts, not assertions that either SDK natively implements those exact methods. Driver startup grants no mutating authority. The Helm API checks the current ownership lease before each primary command. A consulting session gets read-only domain tools and a separately bounded cognition request, never a controller epoch. In independent mode, commit the peer context manifest and result before revealing the primary's candidate/conclusions; in adversarial mode the candidate is intentionally visible but hidden primary reasoning is not required. Record the consultation identity, primary/peer/provider/mode/objective/context/results/resources/disposition.

When an attempt dies without a terminal envelope, record `envelope_missing` and produce an explicitly supervisor-sourced mechanical recovery handoff. Do not fabricate a successful worker envelope. Malformed envelopes and repairable gate failures receive bounded same-session correction only while authority and useful context remain valid. Preserve independent review where required.

Persist raw artifacts to immutable/hash-addressed locations with flush/atomic publication before committing their indexed evidence reference. Reconcile orphan artifacts and missing references after a crash. Raw Pi events can rebuild artifact indexes; unjournaled human rulings, commands or orchestration decisions cannot be inferred from them. Pin trusted gate/policy definitions outside the evaluated worker's uncontrolled write scope, compare actual repository changes with authorised paths, and independently review any explicitly authorised grading-machinery change.

The recovery bundle includes the versioned Brief, current Map and material decisions; live worker/attempt observations; pending and unknown commands; recent handoffs, findings and open gates; integration certificates/results; pool/quota/reserve observations; both lease types; Needs You and orchestrator queues; and recent material Log events. Outgoing summaries are optional. Re-observe authoritative state on consumption. Revoke/fence the old owner, reconcile possible in-flight effects, prepare/start the replacement without mutation authority, and atomically issue its new epoch only after ownership checks. A valid Pi Autonomy Lease can outlive controller loss; an expired one cannot be extended implicitly. A remote effect already started may finish after fencing, so observe reality rather than promise impossible cancellation or blind replay.

Record context_tokens, context_window, observation freshness and compaction count separately from cumulative consumed/cached tokens and money or subscription units. Absent telemetry stays unknown. Unknown quota by itself is not invented zero capacity; refusal follows the actual delegated hard-bound requirements. Confirmed provider failure can trigger a pre-authorised takeover; uncertain status requires observation, and an unavailable/unfunded backup cannot be labelled a successful failover.
