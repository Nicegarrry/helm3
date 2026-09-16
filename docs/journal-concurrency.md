# Journal projection contention

Parallel native Pi workers exposed an immediate SQLite lock failure while indexing a durable prompt artifact. The journal projection now uses a bounded five-second SQLite busy timeout, matching the existing kernel/workspace convention. This waits for short database contention; it does not retry model or tool effects. Longer contention still fails visibly.

Concurrent insertion of an identical source/record is idempotent. A different record under the same source identity is refused without overwriting the original. Raw files and sidecar metadata remain the durable evidence; SQLite remains a reconstructable projection. Failed database setup closes its connection.

Tests exercise a real independent SQLite writer thread holding and releasing a lock, two index connections, identical concurrent insertion and conflicting metadata. Provider calls are not needed for this boundary.
