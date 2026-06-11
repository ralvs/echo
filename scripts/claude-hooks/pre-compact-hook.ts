#!/usr/bin/env bun
/**
 * Claude Code PreCompact hook — invoked before context compression.
 *
 * Captures a "compaction bookmark": a Haiku-summarized snapshot of the active
 * conversation, stored as an episodic thought with a 30-day expiry. The goal
 * is not to lose mid-flight context — current decisions, in-progress
 * problems, things you haven't yet codified — when Claude Code compacts.
 *
 * Idempotent per (session, last_turn_index): if a compaction bookmark already
 * exists for this session at this turn, we skip.
 */

import { basename } from "node:path";
import { generateText } from "ai";
import { postCapture } from "@/scripts/lib/ingest";
import { pairTurns, parseTranscript } from "@/scripts/lib/transcript-prefilter";

type PreCompactPayload = {
	session_id?: string;
	transcript_path?: string;
	hook_event_name?: string;
	cwd?: string;
	trigger?: "manual" | "auto";
};

const SUMMARY_MODEL = "anthropic/claude-haiku-4-5";
const RECENT_TURNS = 12;
const EXPIRES_DAYS = 30;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function summarize(
	turns: { userMessage: string; assistantMessage: string }[],
	projectName: string | undefined,
): Promise<string> {
	const transcript = turns
		.map(
			(t, i) =>
				`--- exchange ${i + 1} ---\nUser: ${t.userMessage}\nAssistant: ${t.assistantMessage}`,
		)
		.join("\n\n");

	const system = `You write a compaction-bookmark for a Claude Code session about to be compressed.
Capture what would be lost: open problems, current hypotheses, decisions just made, in-flight tasks, unresolved questions, key file paths or identifiers.
Skip pleasantries, resolved issues, and anything reproducible from the codebase.
Write 4–8 bullet points in the user's voice. Be specific. No generic advice. No code blocks.
Always write in English. If the exchanges are in another language, translate to English.`;

	const userPrompt = `${projectName ? `Project: ${projectName}\n\n` : ""}Recent exchanges:\n\n${transcript}`;

	const { text } = await generateText({
		model: SUMMARY_MODEL,
		maxOutputTokens: 800,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: userPrompt },
		],
	});
	return text.trim();
}

async function main() {
	const stdinText = await readStdin();
	if (!stdinText.trim()) return;

	let payload: PreCompactPayload;
	try {
		payload = JSON.parse(stdinText) as PreCompactPayload;
	} catch (err) {
		console.error(`[echo-precompact-hook] invalid JSON payload: ${(err as Error).message}`);
		return;
	}

	const transcriptPath = payload.transcript_path;
	if (!transcriptPath) return;

	const messages = parseTranscript(transcriptPath);
	const turns = pairTurns(messages);
	if (turns.length === 0) return;

	const recent = turns.slice(-RECENT_TURNS);
	const sessionId = payload.session_id ?? recent[recent.length - 1].sessionId;
	if (!sessionId) return;

	const lastTurnIndex = recent[recent.length - 1].turnIndex;
	const sourceId = `${sessionId}:precompact:${lastTurnIndex}`;
	const projectName = payload.cwd ? basename(payload.cwd) : undefined;

	let summary: string;
	try {
		summary = await summarize(recent, projectName);
	} catch (err) {
		console.error(`[echo-precompact-hook] summary failed: ${(err as Error).message}`);
		return;
	}
	if (!summary) return;

	const expiresAt = new Date(Date.now() + EXPIRES_DAYS * 86_400_000).toISOString();

	const header = projectName
		? `Compaction bookmark — ${projectName} (session ${sessionId.slice(0, 8)})`
		: `Compaction bookmark (session ${sessionId.slice(0, 8)})`;

	try {
		await postCapture({
			content: `${header}\n\n${summary}`,
			source_id: sourceId,
			source_kind: "claude-precompact",
			expires_at: expiresAt,
			metadata: {
				type: "log",
				topics: ["compaction-bookmark", projectName].filter(Boolean) as string[],
				memory_type: "episodic",
			},
		});
		console.error(`[echo-precompact-hook] captured bookmark for ${sessionId}`);
	} catch (err) {
		console.error(`[echo-precompact-hook] capture failed: ${(err as Error).message}`);
	}
}

main().catch((err) => {
	console.error(`[echo-precompact-hook] unexpected error: ${(err as Error).message}`);
	process.exit(0);
});
