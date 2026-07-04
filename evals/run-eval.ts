#!/usr/bin/env bun
/**
 * Run the retrieval eval against the LIVE Supabase corpus.
 *
 *   bun run eval                       # evals/eval-queries.echo.json
 *   bun run eval path/to/queries.json  # custom golden file
 *
 * Uses the real deps: service-role Supabase client + the AI Gateway embedder
 * (same model that produced the stored vectors). Costs a handful of embedding
 * calls per run. Bun auto-loads .env.local for the credentials.
 */

import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { nodeAi } from "@/lib/model";
import { evalQueries } from "./eval.ts";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
	process.exit(1);
}

const file = process.argv[2] ?? new URL("./eval-queries.echo.json", import.meta.url).pathname;
if (!existsSync(file)) {
	console.error(
		`Golden-query file not found: ${file}\n` +
			"Copy evals/eval-queries.sample.json to evals/eval-queries.echo.json and " +
			"hand-write queries about your own corpus (the file is gitignored).",
	);
	process.exit(1);
}

const deps = { db: createClient(SUPABASE_URL, SUPABASE_KEY), ai: nodeAi };
const summary = await evalQueries(deps, file);

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
console.log(`\n${pad("query", 48)}  nDCG@10  hit@3  rel/10`);
console.log("-".repeat(72));
for (const r of summary.results) {
	const flag = r.hitRate3 === 0 ? "  ←miss" : "";
	console.log(
		`${pad(r.query, 48)}  ${r.ndcg10.toFixed(4)}   ${r.hitRate3}      ${r.relevantInTop10}/${r.returned}${flag}`,
	);
}
console.log("-".repeat(72));
console.log(
	`mean nDCG@10 = ${summary.meanNdcg10.toFixed(4)}   mean hit-rate@3 = ${summary.meanHitRate3.toFixed(4)}   (${summary.results.length} queries)\n`,
);
