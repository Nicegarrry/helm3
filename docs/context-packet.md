# Context packets

`createWorkerContextPacket` receives only caller-selected durable references. It
does not read transcripts, Maps, or decision stores. The second argument is a
trusted host configuration containing the packet byte limit; worker input is
strict and cannot supply or enlarge that limit. Oversize input is refused.

Pi occupancy is an estimated current-context observation from the pinned SDK's
`getContextUsage()` only. A null or missing estimate is recorded as unknown;
session statistics are not substituted for current context size. Compaction,
model changes, and lifecycle recovery remain outside this partial slice.
