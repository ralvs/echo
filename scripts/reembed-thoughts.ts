#!/usr/bin/env bun
/**
 * Re-embed every thought from its current content + metadata.
 *
 *   bun run scripts/reembed-thoughts.ts            # dry run: prints what would change
 *   bun run scripts/reembed-thoughts.ts --apply    # writes new embeddings
 *
 * Run after any change to buildEmbeddingText (e.g. the Owner anchor) so the
 * stored vectors match what new captures produce. Only the embedding column
 * is touched — content and metadata are never modified, so the operation is
 * repeatable and self-correcting.
 *
 * Costs one embedding call per thought. Uses the same embedder that capture
 * uses (lib/model), so recomputed vectors are directly comparable.
 */

import { createClient } from "@supabase/supabase-js";
import { buildEmbeddingText } from "../lib/ai";
import { nodeAi } from "../lib/model";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
	process.exit(1);
}

const apply = process.argv.includes("--apply");
const ownerName = process.env.ECHO_OWNER_NAME ?? null;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const { data: thoughts, error } = await db
	.from("thoughts")
	.select("id, content, metadata, category")
	.order("created_at");

if (error) {
	console.error(`Failed to list thoughts: ${error.message}`);
	process.exit(1);
}

console.log(
	`${apply ? "Re-embedding" : "Dry run over"} ${thoughts.length} thoughts (owner anchor: ${ownerName ?? "none"})\n`,
);

let updated = 0;
for (const t of thoughts) {
	const text = buildEmbeddingText(
		t.content as string,
		(t.metadata ?? {}) as Record<string, unknown>,
		t.category as string | null,
		ownerName,
	);
	console.log(`${(t.id as string).slice(0, 8)}  ${text.split("\n")[0].slice(0, 96)}`);

	if (!apply) continue;

	const embedding = await nodeAi.embed(text);
	const { error: updateErr } = await db.from("thoughts").update({ embedding }).eq("id", t.id);
	if (updateErr) {
		console.error(`  FAILED: ${updateErr.message}`);
		continue;
	}
	updated++;
}

console.log(
	apply ? `\nUpdated ${updated}/${thoughts.length} embeddings.` : "\nDry run — no writes.",
);
