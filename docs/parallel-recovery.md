# Provider-free parallel recovery tracer

`runParallelRecoveryFixture(stateDirectory)` in `src/dogfood/parallel-recovery.ts` is an explicit local-only tracer. It runs three overlapping native Pi sessions on the faux provider in distinct writable worktrees, quarantines one scripted transport failure, reopens the host under a new ownership epoch, and replays durable fleet events twice. `close()` closes local handles but deliberately preserves the state directory and receipt evidence; the caller owns any test cleanup.

Its evidence is deterministic fixture evidence: overlap timestamps, worker identities, retained unknown reservation, three terminal signals with exactly one failure judgement, and stale-epoch refusal. It does not prove live provider/OAuth behaviour, billing, GitHub Map mutations, review/repair, integration, or production isolation.
