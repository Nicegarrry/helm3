# Worker brief template

Use only after build approval; a populated template is not an autonomy lease.

## Verified source

- Ticket number/URL and current authoritative acceptance criteria:
- Human Brief/design version and approved amendments:
- Protocol/contract commit and relevant section references:
- Dispatching coordinator's confirmation that the ticket agrees with those sources:
- Required dependency evidence and handoffs, including exact source SHA for any predecessor reuse:

## Objective

State the narrow behaviour the operator or dependent worker will be able to observe. Include examples, negative cases and a machine oracle where required. Identify uncertainty the worker may resolve independently.

## Assigned seam

- Worktree path, branch, base commit and exclusive write ownership:
- Owned interface/module boundary and consumers:
- Inputs/context manifest; relevant Brief and Map excerpts only:
- Required outputs/schema versions and compatibility rules:
- Out of scope and known parallel owners:

## Authority and resources

- Lease/delegation ID and expiry:
- Approved role/model/provider/pool; capability/data policy requirements:
- Bounds on attempts, requests, concurrency and usage:
- Permitted tools/network/destinations and enforced filesystem boundary:
- What to do on expiry, unknown outcome, provider failure or a needed authority change:

## Evidence and delivery

Commit explicit paths on the assigned branch. Record tested head, exact commands and observed results. Label local mocks, actual SDK execution and live provider evidence separately. Attach a structured handoff: summary, changes/commits, tests, acceptance evidence, decisions, discoveries, risks, open questions and next action. Open a PR; never merge your own work. Preserve failed worktrees for recovery.
