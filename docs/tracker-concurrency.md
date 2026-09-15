# Tracker snapshot concurrency

`GitHubMapTracker.snapshot()` owns a dispatcher for one observation only. It
allows eight active tracker reads by default, with a trusted constructor cap of
sixteen. Request-limit reservation is synchronous before a read enters that
dispatcher, so parallel work cannot overshoot the snapshot's global request
limit.

Independent child nodes and blocker issue reads can run together. Pages for a
single relation remain ordered and sequential. The direct-issue Promise cache
lasts only for the active snapshot; a later snapshot rereads GitHub. Mutation
code keeps its separate final target and dependency fresh reads.

The provider-free delayed 34-child-star fixture observes 35 Map nodes and 105
GETs: one direct issue read plus two relation reads per node. It reaches more
than one active request while never exceeding eight. At a two-millisecond
fixture delay it completed in about 40 ms; a serial 105-read execution has a
minimum delay of about 210 ms. These are local fixture measurements, not a
GitHub latency claim.

Malformed pages, identity mismatches, cycles, duplicate parents, request/page
limits and transport errors still mark the snapshot incomplete and leave its
frontier empty.
