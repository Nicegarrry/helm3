# Independent Pi review

`review.request` lets the active orchestrator request a distinct Pi reviewer for a terminal builder's exact committed head. The host supplies repository, workspace, model and authority mechanics. Review uses the same flexible worker primitive, with a private read-only constraint; it does not prescribe a build/review workflow or confer merge approval.

The host captures the objective, acceptance and factual context as immutable artifact references. Each reference requires a trusted host approval bound to its purpose and actual bytes. An orchestrator cannot approve its own context or pass a builder transcript as independent evidence merely by selecting a generic text artifact. This is provenance enforcement; the host still bears responsibility for what it approves as factual context.

Before launching, the service persists an immutable review intent and an atomic launch claim. Repeated requests reopen the same record. The fleet checks the repository, exact head and empty write scope before starting a distinct attempt, session and worktree. Native review tools expose bounded `helm_read`; shell and write tools are absent. A before snapshot and a fresh after snapshot detect Git changes in that same worktree. This tool policy is not an operating-system sandbox.

Worker output is a claim. The terminal observer reads hash-checked native journal artifacts, validates the complete WorkerResult envelope, binds events to the reviewer attempt/session/spawn command, and verifies the unchanged worktree. Missing, ambiguous or altered evidence leaves the review incomplete. A clear model report does not mint a trusted integration approval.

`IndependentReviewService.reconcile(reviewId, idempotencyKey)` reopens an already launched review and harvests evidence without dispatching another worker. This narrow observation path may collect terminal evidence after controller authority expires; new model requests and mutations still need current authority. A lost or ambiguous launch is never blindly retried. Calling the recovery operation is host mechanics; a continuously running native-session discovery/reconciler is separate work.

Provider-free acceptance uses real Pi sessions, a builder-created commit, a distinct reviewer, the shared Fable/Astra tool bridges, Core resource accounting and persisted evidence. Scripted SDK transports establish control-plane behavior, not live frontier reasoning quality or provider interchange. See the dated acceptance receipt for the exact reviewed commit and observed checks.
