# Operator view evidence

This slice provides a typed, read-only `OperatorSnapshot` projection with an injected asynchronous `SnapshotSource`. The host adapter will supply its `snapshot(runId)` read model; fixture sources are explicitly marked as fixtures. The CLI formatter, loopback JSON API, and HTML cockpit all consume the same validated source result; no adapter, authority store, worker launch, transcript, credential, or file discovery is implicit.

The HTTP factory binds only to `127.0.0.1` on an ephemeral port, accepts only loopback `Host` values and the matching HTTP `Origin`, exposes `GET /api/operator/snapshot` and `GET /`, and has no write endpoint. Rendered fields are HTML escaped. Unknown quota and context values remain explicit `null`/`unknown` fields.

The runtime allowlist rejects unknown envelope fields before serialization, preventing an arbitrary source object from leaking through the API. Map and gate/integration facts remain nullable or explicitly unknown/incomplete; absence is never rendered as zero. Tests prove JSON/HTML projection parity, escaping, origin rejection, and write refusal with a local fixture. Host integration remains a follow-up: the host supplies the source adapter and authoritative state; this module does not invent production defaults.
