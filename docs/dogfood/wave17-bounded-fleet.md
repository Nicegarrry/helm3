# Wave 1 slice: bounded fleet runtime binding

`createBoundedFleetRuntime` supplies native start/rehydrate callbacks for `WorkerFleetBinding`. A trusted host provides per-command worker, finite policy, authority and journal factories. Each setup receives a fresh `BoundedPiAccess`; model identity/context/output bounds must match before authority/journal/native setup. Command/workspace/access are bound by the adapter, and a command cannot be set up twice by the same instance, even after failure. The kernel remains responsible for durable admission, spending and recovery across processes.

The adapter does not grant authority, load credentials, select models, add a workflow or replace existing fork/compaction controls. Caller-owned command/workspace/attempt factories are still required. The operator CLI remains read-only; full Wave 1 acceptance is not claimed from this slice.

## Development evidence

Qwen3.8 Flash produced an initial helper through Helm/Pi; its attempt also requested an unauthorized temporary file, which was refused, and repeated writes until its tool bound stopped it. This attempt did not finish with an accepted result. GLM5.3 Flash wrote the staged boundary tests, noticed a defective assertion helper, then hit its one-write limit; its terminal attempt also remained unaccepted. These artifacts are partial contributions, not successful worker outcomes.

The coordinator fixed guessed import paths and the command identity field, moved duplicate refusal before all factories, enforced context/output identity too, corrected swallowed-error assertions, and added real native faux-provider startup/rehydration coverage. Focused tests:9 passed. Removing the bounded access field deliberately failed the native regression. Full gate and independent source review are required at the frozen commit. Any live fleet proof will be recorded separately from faux-provider tests.
