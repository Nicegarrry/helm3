# Native Pi event spool

Helm records the pinned Pi session event stream as ordered immutable
`pi.event` artifacts. Each batch carries the command, attempt and session
lineage, a first sequence number, and every event in order. Streaming
`message_update` records use Pi JSON mode's lossless delta form: the update
contains usage and the assistant event delta; `message_start` and `message_end`
retain the initial and final messages.

The Pi subscriber API is synchronous, so it provides no awaitable upstream
backpressure. Helm therefore does not claim it can slow an active provider
stream. The spool bounds retained work to 64 KiB or 64 events per batch and at
most 1,024 queued batches. A single complete Pi event, including a terminal
message, has a separate 1 MiB hard limit; a single event may therefore occupy
a batch larger than 64 KiB without truncation. It flushes message, tool, turn and agent boundaries and
waits for durability before a later model or workspace effect. If its queue is
full, it writes an explicit `pi.event.overflow` unknown-tail artifact and the
worker fails closed; it never presents omitted events as a complete stream.

The journal's immutable write and fsync protocol remains unchanged. This is not
compaction, transcript retention policy, or a provider reasoning control.
