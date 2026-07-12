#!/usr/bin/env bun
/**
 * Render the golden-query file as human-readable Markdown for review.
 *
 *   bun run scripts/review-eval-queries.ts
 *
 * Expands each query's `relevant` entries (thought-id prefixes or content
 * substrings) into the full thought text from the LIVE corpus, and writes
 * evals/eval-queries.review.md (gitignored — it contains corpus content).
 * Edit evals/eval-queries.echo.json based on what you read, then rerun
 * `bun run eval`. Rerun this script any time the golden file changes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
	process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const goldenPath = new URL("../evals/eval-queries.echo.json", import.meta.url).pathname;
const reviewPath = new URL("../evals/eval-queries.review.md", import.meta.url).pathname;

const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
	queries: { query: string; relevant: string[] }[];
};

const { data: thoughts, error } = await db.from("thoughts").select("id, content");
if (error) {
	console.error(`Failed to list thoughts: ${error.message}`);
	process.exit(1);
}

const lines: string[] = [
	"# Golden-query review",
	"",
	`Generated ${new Date().toISOString().slice(0, 10)} from the live corpus (${thoughts.length} thoughts).`,
	"Each entry below is what the eval counts as a correct answer for that query.",
	"To change ground truth, edit `evals/eval-queries.echo.json` (id prefixes or",
	"content substrings both work) and rerun `bun run eval`.",
	"",
];

for (const [i, q] of golden.queries.entries()) {
	lines.push(`## ${i + 1}. “${q.query}”`, "");
	for (const needle of q.relevant) {
		const byId = thoughts.filter((t) => (t.id as string).startsWith(needle));
		const matches = byId.length
			? byId
			: thoughts.filter((t) => (t.content as string).toLowerCase().includes(needle.toLowerCase()));
		if (!matches.length) {
			lines.push(`- \`${needle}\` — **⚠ matches nothing in the corpus**`);
			continue;
		}
		for (const t of matches) {
			const oneLine = (t.content as string).replace(/\s+/g, " ").trim();
			lines.push(`- \`${(t.id as string).slice(0, 8)}\` — ${oneLine}`);
		}
	}
	lines.push("");
}

writeFileSync(reviewPath, lines.join("\n"));
console.log(`Wrote ${reviewPath} (${golden.queries.length} queries).`);
