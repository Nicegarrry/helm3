# v1.5 safe upgrades

The running production daemon must remain untouched while this feature is built and tested.

## Contract

- `helm update --stage <git-ref> [--repo <path>]` archives an exact Git commit into a new release directory, installs locked dependencies, and runs typecheck/tests using a separate test home. A failed stage cannot change the running release. Staging publishes only version/revision/path metadata, never credentials.
- `helm update --when-idle [--timeout <ms>]` asks the running daemon to launch its own upgrade helper, retaining its environment. The helper runs independently of the requesting client.
- Drain admission applies across CLI and MCP. Reject new mutating operations, including follow-up turns, reviews, gates and PR operations. Existing operations finish. Reads and explicit worker stops remain available.
- Readiness includes accepted tool calls and the entire worker promise, including its commit/result and review callback. A worker state alone is insufficient. Drain status exposes blockers.
- A timeout never kills work: keep the old daemon running and draining, report timeout, and allow explicit resume/cancel.
- A stopped idle daemon hands over to the staged release on the same port and state directory. The new daemon starts with admission closed. Verify its process/release identity and health before reopening admissions.
- Exactly one daemon may open the shared store. A startup ownership lock is acquired before the database is opened. Ambiguous/stale ownership is an operator recovery condition, never permission to start a second owner.
- Prevent stdio auto-start from racing an upgrade. Do not replay failed mutation requests during the brief restart interval.
- Expose running version, available staged version and lifecycle phase in the dashboard and daemon status.
- Failed startup leaves admission closed with a recovery message; do not roll back a database automatically.
- Signal/shutdown paths must drain safely too. A second signal is not permission to kill active work.

## Scope

Model-policy hot reload and transparent survival of workers across an unexpected process death are future work. The first move from v1.4 or earlier requires a manually coordinated quiet window; the updater must refuse an older daemon without lifecycle support rather than sending it a signal.

## Acceptance

Use temporary homes and synthetic/fake workers only. Prove active worker/gate/callback completion, drain races across clients, timeout preservation and resume, duplicate daemon rejection before store access, failed staging/startup, and a real two-process handover retaining port, model/state data and configuration. Exercise both CLI and MCP admission.
