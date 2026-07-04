/**
 * Shared plumbing for the DB integration suites. They run against a LOCAL
 * `supabase start` stack (Docker) — never production — and are skip-safe:
 * when the stack is unreachable every test is skipped with a warning, so
 * `bun run test` stays green on machines without Docker.
 *
 *   supabase start && bun run test:integration
 *
 * URL and keys default to the Supabase CLI's fixed local development
 * credentials; override with ECHO_TEST_SUPABASE_URL / ECHO_TEST_SERVICE_ROLE_KEY /
 * ECHO_TEST_ANON_KEY if your config.toml changes them.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const LOCAL_URL = process.env.ECHO_TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";

// The CLI's well-known local demo JWTs (supabase status prints them). These
// are not secrets — every local supabase stack ships the same ones.
export const SERVICE_ROLE_KEY =
	process.env.ECHO_TEST_SERVICE_ROLE_KEY ??
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"; // gitleaks:allow — CLI's public local demo key

export const ANON_KEY =
	process.env.ECHO_TEST_ANON_KEY ??
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"; // gitleaks:allow — CLI's public local demo key

// The CLI's fixed local JWT secret, used to mint an authenticated-role token
// without needing an auth flow (local email logins are disabled).
const JWT_SECRET =
	process.env.ECHO_TEST_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";

/** True when the local stack answers within 1.5s. */
export async function probeLocalStack(): Promise<boolean> {
	try {
		const res = await fetch(`${LOCAL_URL}/rest/v1/`, {
			headers: { apikey: SERVICE_ROLE_KEY },
			signal: AbortSignal.timeout(1500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export function serviceClient(): SupabaseClient {
	return createClient(LOCAL_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export function anonClient(): SupabaseClient {
	return createClient(LOCAL_URL, ANON_KEY, { auth: { persistSession: false } });
}

/** Client whose PostgREST role is `authenticated`, via a self-signed local JWT. */
export async function authenticatedClient(): Promise<SupabaseClient> {
	const encode = (obj: Record<string, unknown>) =>
		Buffer.from(JSON.stringify(obj)).toString("base64url");
	const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
		role: "authenticated",
		sub: "00000000-0000-0000-0000-0000000000aa",
		aud: "authenticated",
		exp: Math.floor(Date.now() / 1000) + 3600,
	})}`;
	const { createHmac } = await import("node:crypto");
	const signature = createHmac("sha256", JWT_SECRET).update(unsigned).digest("base64url");
	const jwt = `${unsigned}.${signature}`;
	return createClient(LOCAL_URL, ANON_KEY, {
		auth: { persistSession: false },
		global: { headers: { Authorization: `Bearer ${jwt}` } },
	});
}

export const DIMS = 1536;

/** Deterministic unit-ish vector: `spike` carries almost all the mass, so
 * cosine similarity between two vectors is ~1 when spikes match and ~0
 * otherwise. Deterministic — no model, no randomness. */
export function spikeVector(spike: number, magnitude = 1): number[] {
	const v = new Array<number>(DIMS).fill(0);
	v[spike % DIMS] = magnitude;
	return v;
}

/** Blend of two spikes; cos(blend(a,b), spike(a)) = weightA. */
export function blendVector(spikeA: number, spikeB: number, weightA: number): number[] {
	const v = new Array<number>(DIMS).fill(0);
	v[spikeA % DIMS] = weightA;
	v[spikeB % DIMS] = Math.sqrt(1 - weightA * weightA);
	return v;
}

export type SeedThought = {
	content: string;
	embedding: number[];
	metadata?: Record<string, unknown>;
};

/** Insert thoughts tagged for cleanup; returns their ids in insert order. */
export async function seedThoughts(
	db: SupabaseClient,
	tag: string,
	thoughts: SeedThought[],
): Promise<string[]> {
	const rows = thoughts.map((t) => ({
		content: t.content,
		embedding: JSON.stringify(t.embedding),
		metadata: { ...(t.metadata ?? {}), test_tag: tag },
	}));
	const { data, error } = await db.from("thoughts").insert(rows).select("id");
	if (error) throw new Error(`seedThoughts failed: ${error.message}`);
	return (data as { id: string }[]).map((r) => r.id);
}

export async function deleteTagged(db: SupabaseClient, tag: string): Promise<void> {
	await db.from("thoughts").delete().eq("metadata->>test_tag", tag);
}
