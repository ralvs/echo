import { readFileSync } from "node:fs";
import { ownerText } from "./owner-message";

export type RawTranscriptMessage = {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	timestamp?: string;
	sessionId?: string;
	message?: {
		role?: "user" | "assistant";
		content?: string | Array<{ type: string; text?: string }>;
	};
};

export type Turn = {
	sessionId: string;
	turnIndex: number;
	userMessage: string;
	assistantMessage: string;
	timestamp: string;
};

function extractText(content: RawTranscriptMessage["message"]): string {
	if (!content?.content) return "";
	const c = content.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join("\n")
			.trim();
	}
	return "";
}

export function parseTranscript(filePath: string): RawTranscriptMessage[] {
	const raw = readFileSync(filePath, "utf-8");
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
	const out: RawTranscriptMessage[] = [];
	for (const line of lines) {
		try {
			const obj = JSON.parse(line) as RawTranscriptMessage;
			if (obj.type === "user" || obj.type === "assistant") out.push(obj);
		} catch {
			// Ignore malformed lines (queue-ops, partial writes, etc).
		}
	}
	return out;
}

/**
 * Walk a parsed transcript and emit user→assistant turn pairs. A turn is one
 * user message followed by the next assistant message in document order.
 * Pure assistant tool-output messages with no text are squashed into the
 * preceding assistant text (joined by newlines).
 */
export function pairTurns(messages: RawTranscriptMessage[]): Turn[] {
	const turns: Turn[] = [];
	let pendingUser: { text: string; ts: string; sessionId: string } | null = null;
	let assistantBuffer: string[] = [];

	const flush = () => {
		if (pendingUser && assistantBuffer.length > 0) {
			const assistantText = assistantBuffer.join("\n").trim();
			if (assistantText) {
				turns.push({
					sessionId: pendingUser.sessionId,
					turnIndex: turns.length,
					userMessage: pendingUser.text,
					assistantMessage: assistantText,
					timestamp: pendingUser.ts,
				});
			}
		}
		pendingUser = null;
		assistantBuffer = [];
	};

	for (const m of messages) {
		const text = extractText(m.message);
		if (m.type === "user") {
			flush();
			if (text) {
				pendingUser = {
					text,
					ts: m.timestamp ?? "",
					sessionId: m.sessionId ?? "",
				};
			}
		} else if (m.type === "assistant" && pendingUser) {
			if (text) assistantBuffer.push(text);
		}
	}
	flush();
	return turns;
}

/**
 * Minimum Owner-authored words for a turn to be worth classifying. Low on
 * purpose: real corrections and preferences are short ("no, Luxon not
 * date-fns"). It exists only to drop pure acknowledgements — "go ahead",
 * "yes do it", "thanks" — which carry no durable content.
 */
const MIN_OWNER_WORDS = 6;

/**
 * Pre-filter: cheap, no-LLM heuristics that drop turns unlikely to contain
 * durable knowledge. Returns true to keep the turn.
 *
 * Substance is judged on the *Owner-authored residue* (see ./owner-message.ts),
 * never on raw message length. Raw length is actively misleading here: the
 * harness prepends kilobytes of system reminders and CLAUDE.md to the user
 * role, so a length floor keeps machine preambles and discards the short
 * corrections this pipeline exists to catch.
 */
export function passesPrefilter(turn: Turn): boolean {
	const owner = ownerText(turn.userMessage);
	const a = turn.assistantMessage.trim();

	// Nothing the Owner actually said — harness preamble, a slash-command
	// body, a tool result, or a subagent notification.
	if (!owner) return false;

	// Bare acknowledgement, a pasted file path, or a single command.
	if (owner.split(/\s+/).length < MIN_OWNER_WORDS) return false;

	// Assistant produced only tool calls (no text) — already filtered by pairTurns,
	// but double-check very short assistant replies.
	if (a.length < 40) return false;

	return true;
}
