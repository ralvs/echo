# All content and topics are stored in English

Content sourced from Claude Code hooks or the mine CLI is translated to English before it reaches the capture pipeline — folded into the relevance-gate call, so it costs zero extra API requests (Haiku receives the original exchange and emits English in one shot). Stored content and topics therefore occupy a single language space.

## Why

Embeddings for the same concept in different languages land in different regions of the vector space, so a mixed-language corpus breaks semantic search — a cross-language query silently misses relevant thoughts. A single-language corpus is a hard requirement for consistent retrieval, not a nicety.

## Consequences

- This is expensive to reverse: it's baked into every stored vector, so switching to multilingual storage would require re-embedding the whole corpus.
- Translation lives at the ingestion edge (the gate), not in the core capture pipeline — direct API/dashboard captures are assumed already-English. If a new ingestion source can carry non-English text, it must translate at its own edge before calling capture.
