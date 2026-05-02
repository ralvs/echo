#!/usr/bin/env bun
/**
 * Claude Code Stop hook — invoked after every assistant turn.
 *
 * Reads the transcript file passed by the harness, pulls the last user→assistant
 * pair, asks the relevance gate whether it's worth saving, and if so POSTs to
 * Echo's /api/thoughts. Idempotent via source_id so the same turn is never
 * captured twice across multiple Stop firings within one session.
 *
 * Fail-silent: any error exits 0 with a stderr log so the hook never blocks
 * the user's session.
 */

import { basename } from "node:path";
import { relevanceGate } from "@/lib/relevance-gate";
import { pairTurns, parseTranscript, passesPrefilter } from "@/scripts/lib/transcript-prefilter";

type StopHookPayload = {
	session_id?: string;
	transcript_path?: string;
	hook_event_name?: string;
	stop_hook_active?: boolean;
	cwd?: string;
};

const ECHO_API_URL = process.env.ECHO_API_URL ?? "http://localhost:3000";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function projectNameFromCwd(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	return basename(cwd);
}

async function postCapture(body: Record<string, unknown>): Promise<void> {
	const res = await fetch(`${ECHO_API_URL}/api/thoughts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`POST /api/thoughts failed (${res.status}): ${text.slice(0, 200)}`);
	}
}

async function main() {
	const stdinText = await readStdin();
	if (!stdinText.trim()) {
		console.error("[echo-stop-hook] no stdin payload");
		return;
	}

	let payload: StopHookPayload;
	try {
		payload = JSON.parse(stdinText) as StopHookPayload;
	} catch (err) {
		console.error(`[echo-stop-hook] invalid JSON payload: ${(err as Error).message}`);
		return;
	}

	if (payload.stop_hook_active) {
		// Re-entry guard from Claude Code — don't recurse.
		return;
	}

	const transcriptPath = payload.transcript_path;
	if (!transcriptPath) {
		console.error("[echo-stop-hook] missing transcript_path");
		return;
	}

	const messages = parseTranscript(transcriptPath);
	if (messages.length === 0) return;

	const turns = pairTurns(messages);
	if (turns.length === 0) return;

	const last = turns[turns.length - 1];
	if (!passesPrefilter(last)) return;

	const sessionId = payload.session_id ?? last.sessionId;
	if (!sessionId) return;

	const sourceId = `${sessionId}:${last.turnIndex}`;
	const projectName = projectNameFromCwd(payload.cwd);

	const { decision } = await relevanceGate({
		userMessage: last.userMessage,
		assistantMessage: last.assistantMessage,
		projectName,
	});

	if (!decision.should_capture) {
		console.error(`[echo-stop-hook] skipped (${decision.reason || "not relevant"})`);
		return;
	}

	try {
		await postCapture({
			content: decision.content,
			source_id: sourceId,
			source_kind: "claude-transcript",
			metadata: {
				type: decision.suggested_type,
				topics: decision.suggested_topics,
				memory_type: decision.memory_type,
			},
		});
		console.error(`[echo-stop-hook] captured turn ${last.turnIndex} of ${sessionId}`);
	} catch (err) {
		console.error(`[echo-stop-hook] capture failed: ${(err as Error).message}`);
	}
}

main().catch((err) => {
	console.error(`[echo-stop-hook] unexpected error: ${(err as Error).message}`);
	// Never block the user's session.
	process.exit(0);
});
