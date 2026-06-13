# Metadata extraction runs before embedding, sequentially

In the capture pipeline, the Haiku metadata-extraction call completes before the embedding call starts. The embedding input is the *enriched* text — content plus the extracted topics, category, and people appended — so the vector encodes the metadata concepts, not just the raw words. The two calls are deliberately **not** parallelized.

## Why this is recorded

The instinct is to fire both model calls at once to cut latency. That's the rejected option: the embedding depends on extraction's output, so running them in parallel would mean embedding the raw text and losing the metadata signal that makes semantic search match on concepts like topic and category. Consistent, concept-aware vectors beat the latency win.

## Consequences

- Capture latency is the sum of the two calls, by design.
- `buildEmbeddingText` (`_shared/ai.ts`) defines the enrichment shape; changing it changes what future vectors encode. It does **not** retroactively re-embed existing thoughts — a model or enrichment change needs a backfill (the same constraint that makes [0013](0013-single-language-english-storage.md) hard to reverse).
