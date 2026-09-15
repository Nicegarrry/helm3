# Wave 2 Pi native runtime evidence

`test/runtime/pi-native.test.ts` runs Pi 0.85.1 with its packaged faux provider
and in-memory credentials. It creates an exact-base Git worktree, starts a real
Pi session with all built-ins disabled, and exposes only `helm_write`.

Each faux model request and the write tool pass through a real Helm kernel
admit/claim/perform lifecycle. The test observes the native write, Pi event
artifacts plus a terminal envelope artifact, a malformed envelope repaired by
one same-session follow-up, and persistence/reopen with the same Pi session ID.

The worker uses an empty trusted Pi resource loader, so repository and user
extensions, context files, settings, shell tools, credential reads, and network
tools are unavailable. Workspace paths refuse Git/control paths, traversal,
symlink components, and hard-linked write targets. The terminal `changed_files`
claim is compared to the observed Git diff.

This is a local faux-provider proof only. It makes no provider request and does
not establish a shell or process containment boundary because this slice exposes
no shell or subprocess tool. Worktree ownership is currently process-local;
durable reservation/fencing is supplied by the authority slice at integration.
