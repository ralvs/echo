# Embedding text is anchored to the Owner's name

`buildEmbeddingText` prefixes every thought's content with `About <owner>:` (the `ECHO_OWNER_NAME` env var, threaded through `EchoDeps.ownerName`) before embedding. First-person captures ("Got a raise…") never mention the Owner by name, while retrieval queries almost always do ("what is Renan's salary") — so unanchored first-person thoughts sat systematically farther from every query than third-person profile thoughts, regardless of topical relevance.

## Why this is recorded

The eval's one true miss (the salary thought, nDCG 0) was first blamed on alias fragmentation, then on the similarity threshold, then on the candidate pool — all measured and disproven. Offline cosine probes showed the anchor alone lifted the missing thought above its strongest competitor on all three salary paraphrases (0.34 → 0.63 vs 0.57). Applying it corpus-wide took the live eval from nDCG@10 0.862 / hit@3 0.88 to 0.884 / 0.92 and fixed the miss at rank 1. The rejected alternatives: per-search LLM query expansion (cost, latency, ~50-doc corpus) and hand-curated synonym lists (overfits the golden queries).

## Consequences

- The anchor is config, not code: an unset `ECHO_OWNER_NAME` silently produces unanchored (pre-ADR) embeddings. Every runtime that writes embeddings — dashboard (`lib/`), MCP edge function (`ECHO_OWNER_NAME` secret), scripts — must have it set, or captures drift from the backfilled corpus.
- Changing the anchor (or the owner's name) requires re-running `bun run scripts/reembed-thoughts.ts --apply`, per the same backfill constraint as [0012](0012-extraction-before-embedding.md).
- Anchoring is uniform, so it cancels out between thoughts: it closes the first- vs third-person gap but cannot help pure paraphrase distance (the "how much does Renan earn per month" residual — see the eval's stress queries).
