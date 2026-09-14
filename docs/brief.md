# Helm 3 Brief

Status: concise rendering of the human's supplied design, not a replacement for it. The full [design source](design-source.md) remains authoritative. Changes to fixed requirements need an explicit human ruling.

## Outcome

Maximise accepted, high-quality engineering progress between meaningful human interventions. Helm is a durable control plane for long-running, multi-agent software development. Models exercise judgement; deterministic machinery provides memory, execution, evidence, constraints and recovery.

## User and experience

The initial operator supplies product/engineering direction and delegated boundaries. The active orchestrator interprets the Brief, evolves a GitHub-backed Map, selects models, dispatches Pi workers, handles engineering exceptions and closes outcomes against evidence. The operator should not manage individual workers or reconstruct a run after failures.

Reference scenario: add Instagram sharing to a capture system so shared content is properly represented in the wiki. Helm must investigate uncertainty, adapt the Map, implement, test, review, repair, integrate and validate the intended outcome.

## Fixed requirements

1. The human owns the Brief. The active orchestrator may propose changes, not silently make them.
2. The Map is fluid. GitHub owns issue/PR facts; Git/GitHub/CI own repository facts; Pi owns live sessions; Helm's Log owns orchestration history. UI projections are disposable.
3. One active, replaceable frontier orchestrator uses typed Helm tools: Fable through Claude Agent SDK or Astra through Codex SDK. A deliberately small driver handles lifecycle/tool differences without abstracting reasoning. Pi Agent SDK plus the Helm extension is the single native worker fabric.
4. Models choose work decomposition, topology, routing and review depth. Helm refuses invalid choices without encoding a fixed development workflow.
5. Consequential actions have an immutable validated command, execution record and observed result. Fresh facts authorise effects. Irreversible operations bind to exact evidence and are read back.
6. Authority expires. Lease expiry stops new spending; observation and evidence collection continue. Hard correctness rules cannot be waived by either orchestrator.
7. One writer owns one isolated worktree. Review independence and machine oracles are enforced where required. Failed work and structured handoffs survive agent loss.
8. The deterministic supervisor handles unambiguous mechanics; the active orchestrator handles judgement. The reconciler recovers across process death and ambiguous state.
9. Economy preserves separate subscription/API/top-up pools, unknown values, capability floors, data policy, per-pool usage provenance and a protected active-orchestrator reserve that no orchestrator can self-override.
10. CLI and local cockpit use the same core API. Needs You contains human decisions; normal engineering exceptions belong to the active orchestrator.
11. External cognition is tracked. Context is deliberately scoped and compressed. Calibration informs model judgement without automatically re-tiering models.
12. One orchestrator ownership lease with monotonic epochs fences every mutating command from queue through effect; it is separate from the bounded Autonomy Lease. Peer consultation has independent context, no mutation authority, and a recorded disposition. Recovery reconstructs from durable state rather than a predecessor transcript; provider state that cannot be confirmed fails closed.
13. Workers return typed claims; gates record the exact evidence they checked. Repairable gate near-misses normally return to the same Pi session. Protected paths use preventive scope policy and post-diff detection. Append-only raw artifacts are execution evidence and the artifact indexes are rebuildable projections; authoritative orchestration Log facts require their own durable records. Context occupancy is tracked separately from resource cost.
14. The complete original 39-section design plus addendum, including runtime steering/forking/compaction, dynamic review, closure and migration, remains the build target.

## Current delegated authority

On 2026-09-15 the human authorised independent preparation: a new private repository, GitHub Map/issues, briefing documents, and hours 0–4 work that does not depend on Helm CLI. Opus is completing predecessor Milestone 1. Do not touch that repository or its worktrees. The latest instruction authorises saving this addendum and revising the Map/plan, then requires a context clean followed by an explicit go-ahead before the first implementation wave.

The new repository is an authorised preparation location. Final history-preserving migration/import is a later decision; no claim that this setup has already preserved predecessor history.

## Resources and planning target

Use Terra/Luna workers where appropriate and retain frontier cognition for coordination, difficult decisions and acceptance. The addendum expands the target: use 48–72 elapsed hours of continuous multi-agent execution after build authorisation with a 96-hour contingency, or explicitly re-estimate at six hours from observed constraints. This is not a promise or a spending lease. No dollar cap, live provider probe allowance, continuous-run lease or production merge authority has yet been granted. Absence of a limit is not unlimited authority.

## Completion evidence

Pass the complete [acceptance protocol](acceptance.md): real feature intent, Map evolution, three parallel Pi workers, resource-informed routing, a controlled failure, independent review, repair, exact-head merge, primary restart, state reconstruction, lease behaviour, repository/Map agreement and accurate UI. Record accepted outcomes, interventions, costs, recovery and reproducible evidence. A green unit suite alone is not completion.

## Escalate to the human only for

Product intent ambiguity; fixed Brief changes; spending/authority beyond delegation; high-impact risk; genuinely stuck decisions. Routine engineering failures, review disagreement and recoverable conflicts go to the active orchestrator.
