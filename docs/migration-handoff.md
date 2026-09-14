# Helm CLI to Helm 3 migration handoff boundary

This repository begins independently while Opus completes Helm CLI Milestone 1.
Until an explicit handoff includes an immutable source SHA, do not inspect,
fetch, copy, test or depend on the predecessor repository. Receiving the packet
is a preparation gate only; import still requires build approval.

## Required handoff packet

The handoff must provide source repository and exact commit SHA; Milestone 1
scope and known exclusions; commands and observed test/CI results at that SHA;
behavioural invariants and documented landmines; public interfaces/configuration;
ledger schema/migration notes; and an explicit statement of what may be reused.

## Import review

Create a SHA-bound import record. Classify each candidate as: keep behaviour and
reuse code; keep behaviour but rewrite behind a Helm 3 interface; test oracle
only; or deliberately retire. Preserve useful deterministic behaviour for model
registry/calibration, pools/budget/quota observations, routing refusals, tracker,
ledger/attempts, output envelopes, worktree safety, gates, tamper detection,
merge evidence, handoffs, resource reclamation and fresh-read-before-action.

Do not import adapter architecture, terminal lifecycle inference, prompt-file
orchestration, subprocess worker abstraction, or Herdr as core runtime. Pi is
the target native runtime. Every imported behaviour must pass the Helm 3 command,
authority and evidence contracts and retain provenance to the handoff SHA.
