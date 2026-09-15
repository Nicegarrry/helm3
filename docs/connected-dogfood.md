# Connected provider-free dogfood

`src/dogfood/index.ts` supplies `runLocalFixture({ stateDirectory, orchestrator })` for a deliberately local, fixture-labeled integration path. It requires a newly created empty state directory and returns the durable host reader, workspace path, checkpoint/recovery references, observed command state, the fixture clock, and counts derived from successfully observed `pi.model` and `pi.write` command records.

The fixture has two real adapter paths:

- **Fable** uses the pinned Claude Agent SDK types, its in-process SDK MCP callback, and an injected local query generator.
- **Astra** uses `AstraDriver`, the pinned Codex SDK with a local executable, and a freshly generated loopback MCP bridge. The executable imports the pinned MCP client by file URL, initializes it, and calls the registered `worker.spawn` tool. The bridge token stays in an in-memory environment fragment and is never written to fixture output or artifacts.

Both paths execute six bounded fixture turns: initial `worker.spawn`, a deliberately red `gate.run`, `worker.steer` for same-session repair, a green `gate.run`, `map.update`, and `map.close`. They create a Pi-native worker with Pi's packaged faux provider and in-memory credentials, write `result.txt` through the guarded `helm_write` tool, persist raw events/envelopes/usage plus driver recovery state, checkpoint, stop their first session, close the host, reopen it, resume a fresh driver from the durable bundle, and run a no-tool continuation. The test confirms that reopening did not produce additional workspace writes and that the second model saw prior context. A mismatched duplicate trusted caller is refused, a protected path write is refused, and a new command with a still-valid parent grant and command deadline is refused specifically because its autonomy lease has expired while the orchestrator ownership remains live.

The fixture reports only local facts. Each current run observes four known `fixture-requests` model settlements and two workspace writes; these are faux Pi requests, not provider usage, quota, entitlement, or billing evidence. The stored attempt is an immutable start record. The fixture reports the normal Pi stop observation, which the host projects as lifecycle `finished` and the operator projects as `stopped`; it does not invent an accepted or succeeded attempt outcome.

The observer CLI is intentionally explicit and local:

```sh
node --import tsx src/dogfood/observe.ts --orchestrator fable --state-directory /private/tmp/helm3-dogfood-fable
node --import tsx src/dogfood/observe.ts --orchestrator astra --state-directory /private/tmp/helm3-dogfood-astra
```

Appending `--serve` retains the fixture and starts an ephemeral loopback-only operator view. Its JSON announcement includes the browser URL and `/api/operator/snapshot`; it is read-only and closes the server and fixture on `SIGINT` or `SIGTERM`.

It retains the supplied state directory for inspection. It performs no login, account read, provider request or GitHub operation, and its only network activity is the generated loopback MCP server used by the Astra adapter.

`test/dogfood/connected.test.ts` also runs a fixture-only crash oracle. A child process blocks after the Pi `helm_write` action has completed but before the host observes it; the parent receives its local marker, kills that child, reopens the host state, and observes the parent command as `unknown`. The same command is not claimable for replay, its nested `pi.write` record is also `unknown`, its replay action is never entered, and the already-written file remains byte-for-byte unchanged. This is local fault evidence only.
