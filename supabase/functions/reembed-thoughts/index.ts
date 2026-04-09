import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

// Mirrors buildEmbeddingText from echo-mcp/ai.ts
function buildEmbeddingText(
	content: string,
	metadata: { topics?: unknown; type?: string },
	category: string | null,
): string {
	const parts = [content];
	const topics = Array.isArray(metadata.topics) ? (metadata.topics as string[]) : [];
	if (topics.length) parts.push(`Topics: ${topics.join(", ")}`);
	if (category) parts.push(`Category: ${category}`);
	if (metadata.type && metadata.type !== "observation") parts.push(`Type: ${metadata.type}`);
	return parts.join("\n\n");
}

async function getEmbeddingsBatch(texts: string[], apiKey: string): Promise<number[][]> {
	const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/text-embedding-3-small",
			input: texts,
		}),
	});
	if (!r.ok) {
		const msg = await r.text().catch(() => "");
		throw new Error(`Embeddings API failed: ${r.status} ${msg}`);
	}
	const d = await r.json();
	// Sort by index to guarantee alignment with input array
	return (d.data as { index: number; embedding: number[] }[])
		.sort((a, b) => a.index - b.index)
		.map((x) => x.embedding);
}

const PAGE_SIZE = 100;
const DELAY_MS = 200;

Deno.serve(async (req) => {
	if (req.method !== "POST") {
		return new Response(JSON.stringify({ error: "Method not allowed" }), {
			status: 405,
			headers: { "Content-Type": "application/json" },
		});
	}

	const authHeader = req.headers.get("authorization") ?? "";
	const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
	const providedKey = req.headers.get("x-echo-key") ?? bearerKey;
	const accessKey = Deno.env.get("MCP_ACCESS_KEY");
	if (!providedKey || providedKey !== accessKey) {
		return new Response(JSON.stringify({ error: "Invalid or missing access key" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const supabase = createClient(
		Deno.env.get("SUPABASE_URL")!,
		Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
	);
	const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;

	let processed = 0;
	let skipped = 0;
	let page = 0;

	while (true) {
		const { data: thoughts, error } = await supabase
			.from("thoughts")
			.select("id, content, metadata, category")
			.order("created_at", { ascending: true })
			.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

		if (error) {
			return new Response(
				JSON.stringify({ error: error.message, processed, skipped, pages: page }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}

		if (!thoughts || thoughts.length === 0) break;

		// Build enriched texts for the whole batch
		const texts = thoughts.map((t) =>
			buildEmbeddingText(t.content, t.metadata || {}, t.category),
		);

		try {
			const embeddings = await getEmbeddingsBatch(texts, openrouterKey);

			// Bulk update each thought with its new embedding
			for (let i = 0; i < thoughts.length; i++) {
				const { error: updateErr } = await supabase
					.from("thoughts")
					.update({ embedding: embeddings[i] })
					.eq("id", thoughts[i].id);

				if (updateErr) {
					console.error(`Failed to update ${thoughts[i].id}:`, updateErr.message);
					skipped++;
				} else {
					processed++;
				}
			}
		} catch (err) {
			console.error(`Batch ${page} failed:`, (err as Error).message);
			skipped += thoughts.length;
		}

		page++;

		// Brief pause between pages to avoid rate limits
		if (thoughts.length === PAGE_SIZE) {
			await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
		} else {
			break; // Last page was partial — we're done
		}
	}

	return new Response(
		JSON.stringify({ processed, skipped, pages: page }),
		{ headers: { "Content-Type": "application/json" } },
	);
});
