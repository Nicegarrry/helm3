# Native command

`npm run native -- --config /absolute/path/config.json --json` is the public
entry point for one bounded native worker. The command opens the existing Host
ledger, reads an already admitted command before model or credential setup, and
returns a JSON result. It never records a human grant, issues an autonomy
lease, renews ownership, or chooses a provider.

The config is versioned and strict. It binds `runId` and `taskId`, repository
and exact `baseSha`, objective/acceptance/context artifact references, the
existing autonomy and ownership identities, model/provider/API/base URL and
fact version, credential environment name, writable scope, and the complete
bounded request/resource policy. The schema has no credential-value field, and endpoint URLs reject user
credentials and query strings. The policy base URL must equal the pinned model base URL.

Each run/task gets a durable manifest in the shared state directory. The
manifest digest is included in the canonical `worker.spawn` payload. A second
invocation observes that command and its durable terminal/envelope evidence;
it does not resolve credentials or dispatch another worker. A changed config
with the same run/task identity fails closed. Distinct task IDs receive
distinct manifests and command identities in the same ledger.

For embedding and provider-free tests, use
`createNativeCommandEnvironment`. It constructs `createBoundedFleetRuntime`
and `PiWorkerFleet` from trusted Host, WorkspaceManager, model runtime, model,
policy and authority inputs. The fixture must use a newly created empty state
directory; it must never point at a live account state directory.

Provider-free fixture coverage and live acceptance are tracked separately in issue126. A successful fixture never establishes OAuth, quota, billing or live model availability.

The JSON `state` describes the worker outcome, and `commandStatus` describes
launch admission. Exit0 requires an accepted successful worker result; exit1
means failed/cancelled/refused, and exit2 means queued/running/unknown.
SIGINT or SIGTERM requests a graceful local stop through the existing authority.
An unconfirmed stop remains unknown; neither signal releases uncertain billing
or deletes the worktree.

Before a new launch, a trusted coordinator must have already recorded the human
grant, autonomy lease, ownership and model registry facts in the same Host
ledger and saved the referenced objective/context artifacts. This command does
not provision accounts or mint those records. It reads credentials only from
the configured environment variable. Never put the credential value in a config
or tracked file. Reuse the same state directory and stable run/task identity
when inspecting or restarting; changing task IDs is not a recovery operation.


For the provider-free acceptance smoke, run:

```sh
npm exec -- tsx --test test/host/native-command.test.ts test/host/native-command-cli.test.ts
```

These tests create isolated temporary repositories and authority fixtures. The
launch test injects the actual Pi faux provider into the same host composition;
the replay test exercises the shipped CLI in a fresh process. No live account
state, provider request or OAuth session is needed.
