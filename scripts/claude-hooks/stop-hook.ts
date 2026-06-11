#!/usr/bin/env bun
/**
 * Claude Code Stop hook — invoked after every assistant turn.
 *
 * Reads the transcript file passed by the harness, pulls the last
 * user→assistant pair, and feeds it to the shared ingestion workflow
 * (prefilter → relevance gate → idempotent POST to Echo).
 *
 * Fail-silent: any error exits 0 with a stderr log so the hook never blocks
 * the user's session.
 */

import { basename } from "node:path";
import { ingestTurn } from "@/scripts/lib/ingest";
import { pairTurns, parseTranscript } from "@/scripts/lib/transcript-prefilter";

type StopHookPayload = {
	session_id?: string;
	transcript_path?: string;
	hook_event_name?: string;
	stop_hook_active?: boolean;
	cwd?: string;
	cursor_version?: string;
};

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
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

	if (payload.cursor_version) {
		// Running inside Cursor — skip, this hook is Claude Code only.
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

	const result = await ingestTurn(last, {
		sessionId: payload.session_id,
		projectName: payload.cwd ? basename(payload.cwd) : undefined,
	});

	switch (result.outcome) {
		case "captured":
			console.error(`[echo-stop-hook] captured turn ${last.turnIndex} (${result.sourceId})`);
			break;
		case "duplicate":
			console.error(`[echo-stop-hook] already captured (${result.sourceId})`);
			break;
		case "skipped":
			console.error(`[echo-stop-hook] skipped (${result.reason})`);
			break;
		case "error":
			console.error(`[echo-stop-hook] capture failed: ${result.reason}`);
			break;
	}
}

main().catch((err) => {
	console.error(`[echo-stop-hook] unexpected error: ${(err as Error).message}`);
	// Never block the user's session.
	process.exit(0);
});
