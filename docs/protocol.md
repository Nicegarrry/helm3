# Proposed minimum protocol, revision 0

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
  leaseId: string;
  leaseRevision: number;
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

Persist intent before the effect. A crash after `effect_started` yields an unknown outcome. Observe external identity first: attempt/session ID for spawn, check-run identity for gates, PR/head identity for merge. Reconcile already-completed effects to success. Retry only when absence is established and authority still allows it. Where absence cannot be proved, retain unknown and wake Fable. Immutable commands never mutate into a new instruction; changed intent produces a new linked command.

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

Revocation is a durable event and takes priority over expiry. Renewal creates an attributable revision and rechecks its parent authority; Fable cannot enlarge human delegation or authorise reserve consumption. A human may approve a declared discretionary limit override; physical/provider constraints and hard correctness rules remain non-overridable.

Reserve capacity atomically before billable requests, retries, forks that generate summaries, compaction, model probes, reviews and external cognition. Accounting distinguishes observed actual usage from reserved upper bounds and unknown final consumption. Never silently convert token quotas to dollars. If a hard pool cap cannot be enforced because a worst-case bound is unknown, refuse that spend; expose the reason for an authority decision.

Expiry prevents new billable requests and new tool effects, including autonomous follow-ups within a still-running SDK session. Request cancellation of in-flight requests/processes, collect final usage when available, and record any unknown usage. Remote cancellation cannot guarantee zero subsequent provider charge: reserve the possible in-flight amount beforehand. Monotonic elapsed time plus conservative wall-clock revalidation prevents local clock rollback from extending a lease. Monitoring and result collection remain allowed after expiry.

## Events, attempts and sessions

Event minimum: `eventId`, `schemaVersion`, `kind`, `source`, `sourceEventId`, `occurredAt`, `recordedAt`, `commandId?`, `attemptId?`, `sessionId?`, `correlationId`, `causationId?`, `payload`. Enforce deduplication by source identity; do not assume remote clocks or delivery order establish causality. A durable per-consumer cursor and idempotent handler make projection rebuild and wake replay safe.

Attempt minimum: `attemptId`, Map node/revision, objective/acceptance version, role label, initial model/family/capability/pool snapshot, workspace/base SHA, context manifest hash, lease ID, session IDs, start/end observations, outcome, usage records, findings, evidence IDs and handoff ID. A model change is a new attributable segment; it never rewrites historical model/family/cost facts. Review independence checks all relevant contributing segments, not just the last selected model.

Worktree ownership is a separate fenced record: repository, canonical path, allowed write roots, branch/base SHA, attempt owner, generation and expiry. Process PID alone is not a session identity. SDK session continuation must re-establish live ownership before work; a persisted transcript is not proof the original process survived.

## Integration certificate

`IntegrationPrepare` returns an immutable certificate containing repository/PR, exact expected head SHA, target branch and observed base SHA, merge method, required checks and conclusion identities, required independent review/evidence identities, acceptance version, lease revision, preparation time and expiry. Revalidate all mutable preconditions at merge time. Head changes invalidate head-bound evidence. Target/base changes re-evaluate mergeability and every base-sensitive oracle; do not quietly reuse a test against another base.

Use the provider's exact-head compare-and-merge facility where available. A local read followed by an unconditional merge is insufficient. If target-branch freshness cannot be made atomic with the required integration policy, use branch protection/merge queue or an equivalent conditional integration lane and record its guarantees. After ambiguous API failure, read actual PR/commit state before retrying. Success requires observed resulting merge SHA and target ancestry. Map closure is a separate evidence-bound command.

## Fable and client seams

Typed Helm tools call the same application service as CLI and cockpit. The initial transport proposal is a local authenticated loopback API with machine-readable envelopes; no public listener by default. Read APIs expose observation provenance and freshness. Mutating APIs accept command intent and return command IDs; clients cannot supply trusted review approval or lease authority merely by populating fields.

Fable wake records contain reason IDs, affected scope, evidence references and a deduplication key. Claim one wake batch per scope; persist consumed reasons and new commands before acknowledging. Coalesce repeated no-change observations, retain materially new evidence, and do not wake a model for routine polling. Fable restarts recover from the durable queue and Brief/Map/Log, not only an SDK transcript. Human decisions use a separate queue and authenticated human ruling.

The public tool surface remains the small set in source section 7; kinds compose different workflows. Required review may be launched deterministically only when the requirement already exists and the lease permits it. These local object lifecycles do not prescribe one global engineering state machine.

## Containment proposal

Candidate for the initial macOS host: Pi tools wrapped by the upstream sandbox-runtime integration, with an allowlist of the assigned canonical workspace and dedicated temporary/cache locations. Keep GitHub mutation credentials and Helm database authority outside worker access. Deny other write roots, control child-process inheritance and network destinations, and prevent write-through symlinks or access to sibling worktrees. Read-only review sessions cannot obtain shell write authority.

This candidate is not accepted as a security boundary until its real OS-backed oracle passes: allowed write succeeds, direct/shell/subprocess/symlink writes outside scope fail, review write fails, expired lease refuses subsequent effects, and child cleanup is observed. If the host/runtime cannot enforce this, the first build decision is a supported Linux/container execution lane or narrower tools—not a prompt that claims isolation. SDK interception and local mock tests alone do not prove containment.
