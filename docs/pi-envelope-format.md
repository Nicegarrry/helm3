# Pi terminal envelope format

Helm accepts a strict `WorkerResult` JSON object directly, or exactly one whole
Markdown fence labelled `json` whose contents validate as that same strict
object. The normalization does not extract JSON from prose or multiple blocks,
and it does not verify the report's claims. The raw terminal bytes remain the
immutable `pi.envelope` artifact unchanged.
