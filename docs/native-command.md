# Native command

`src/cli/native.ts --config /absolute/path/config.json --json` is the public
entry point for one bounded native worker. The command opens the existing Host
ledger, reads an already admitted command before model or credential setup, and
returns a JSON result. It never records a human grant, issues an autonomy
lease, renews ownership, or chooses a provider.

The config is versioned and strict. It binds `runId` and `taskId`, repository
and exact `baseSha`, objective/acceptance/context artifact references, the
existing autonomy and ownership identities, model/provider/API/base URL and
fact version, credential environment name, writable scope, and the complete
bounded request/resource policy. A credential value cannot be represented in
the file. The policy base URL must equal the pinned model base URL.

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

Provider-free fixtures prove composition, durable command admission, worktree
ownership, native Pi envelope handling and output evidence. They do not prove
OAuth, quota, billing, or live model availability.
