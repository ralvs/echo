/**
 * upsert_entity / upsert_entity_edge semantics (migration 00021) plus the
 * 00024 hardening regression: anon and authenticated roles must NOT be able
 * to execute the three service-role-only RPCs. Local stack only, skip-safe.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { anonClient, authenticatedClient, probeLocalStack, serviceClient } from "./local-stack.ts";

const ready = await probeLocalStack();
if (!ready)
	console.warn("[integration] local supabase stack unreachable — skipping entity RPC suite");

const db = serviceClient();
const RUN = Date.now();
const name = (n: string) => `it-${RUN}-${n}`;

async function upsertEntity(type: string, entityName: string): Promise<string> {
	const { data, error } = await db.rpc("upsert_entity", { p_type: type, p_name: entityName });
	if (error) throw new Error(error.message);
	return data as string;
}

async function edgeRow(source: string, target: string) {
	const [s, t] = source < target ? [source, target] : [target, source];
	const { data } = await db
		.from("entity_edges")
		.select("source_id, target_id, weight")
		.eq("source_id", s)
		.eq("target_id", t)
		.maybeSingle();
	return data as { source_id: string; target_id: string; weight: number } | null;
}

afterAll(async () => {
	if (!ready) return;
	// entity_edges rows cascade with their endpoints.
	await db.from("entities").delete().like("canonical_name", `it-${RUN}-%`);
});

describe.skipIf(!ready)("upsert_entity", () => {
	it("is idempotent per (type, canonical_name) and distinct across types", async () => {
		const first = await upsertEntity("person", name("ada"));
		const again = await upsertEntity("person", name("ada"));
		expect(again).toBe(first);

		const asProject = await upsertEntity("project", name("ada"));
		expect(asProject).not.toBe(first);
	});

	it("rejects types outside the check constraint", async () => {
		const { error } = await db.rpc("upsert_entity", { p_type: "planet", p_name: name("mars") });
		expect(error).not.toBeNull();
	});
});

describe.skipIf(!ready)("upsert_entity_edge", () => {
	it("canonicalizes direction and increments weight on repeat", async () => {
		const a = await upsertEntity("person", name("a"));
		const b = await upsertEntity("person", name("b"));

		await db.rpc("upsert_entity_edge", { p_source: a, p_target: b });
		expect((await edgeRow(a, b))?.weight).toBe(1);

		// Reversed direction must hit the SAME undirected edge.
		await db.rpc("upsert_entity_edge", { p_source: b, p_target: a });
		const edge = await edgeRow(a, b);
		expect(edge?.weight).toBe(2);
		expect(edge && edge.source_id < edge.target_id).toBe(true);
	});

	it("ignores self-edges", async () => {
		const a = await upsertEntity("person", name("self"));
		const { error } = await db.rpc("upsert_entity_edge", { p_source: a, p_target: a });
		expect(error).toBeNull();
		expect(await edgeRow(a, a)).toBeNull();
	});
});

describe.skipIf(!ready)("00024 RPC hardening regression", () => {
	const HARDENED: { rpc: string; args: Record<string, unknown> }[] = [
		{ rpc: "upsert_entity", args: { p_type: "person", p_name: "intruder" } },
		{
			rpc: "upsert_entity_edge",
			args: {
				p_source: "00000000-0000-0000-0000-000000000001",
				p_target: "00000000-0000-0000-0000-000000000002",
			},
		},
		{ rpc: "get_thought_stats", args: {} },
	];

	async function expectDenied(client: SupabaseClient, role: string) {
		for (const { rpc, args } of HARDENED) {
			const { error } = await client.rpc(rpc, args);
			expect(error, `${role} must not execute ${rpc}`).not.toBeNull();
			expect(error?.message ?? "").toMatch(/permission denied/i);
		}
	}

	it("anon cannot execute the hardened RPCs", async () => {
		await expectDenied(anonClient(), "anon");
	});

	it("authenticated cannot execute the hardened RPCs", async () => {
		await expectDenied(await authenticatedClient(), "authenticated");
	});

	it("service_role retains execute", async () => {
		const { error } = await db.rpc("get_thought_stats");
		expect(error).toBeNull();
	});
});
