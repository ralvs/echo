import { generateText } from "ai";

export type GateInput = {
	userMessage: string;
	assistantMessage: string;
	projectName?: string;
	priorContext?: string;
};

export type GateDecision = {
	should_capture: boolean;
	content: string;
	suggested_topics: string[];
	suggested_type: string;
	memory_type: "fact" | "preference" | "episodic" | "procedural";
	reason: string;
};

export type GateResult = {
	decision: GateDecision;
	usage: { inputTokens: number; outputTokens: number };
};

const GATE_MODEL = "anthropic/claude-haiku-4-5";

const SYSTEM_PROMPT = `You decide whether a single user→assistant exchange from a Claude Code session is worth saving to a personal knowledge base.

Capture criteria (any ONE is enough):
- A decision the user made or confirmed (architectural, library, business, lifestyle).
- An expressed preference ("I prefer", "always do X", "avoid Y") that should persist across future sessions.
- A non-obvious learning, gotcha, or fact about a system, codebase, or domain.
- An action item or follow-up that needs to be remembered (TODO, "let's do X next week").
- A new piece of context about a project's goals, constraints, or stakeholders.

DO NOT capture:
- Pure code-execution results, file reads, tool output dumps.
- Trivial back-and-forth ("ok", "thanks", "yes please").
- Re-statements of public documentation that's easy to re-derive.
- Short clarifying questions without resolution.
- Long debugging sessions where nothing was concluded.

When capturing, write a self-contained "content" string in the user's voice — a single statement that will make sense out of context six months from now. Don't quote the assistant verbatim; distill the durable fact.

Return ONLY valid JSON, no markdown fences:
{
  "should_capture": boolean,
  "content": "self-contained statement (empty if should_capture is false)",
  "suggested_topics": ["1-3 short tags"],
  "suggested_type": "observation | task | idea | reference | person_note | preference | decision",
  "memory_type": "fact | preference | episodic | procedural",
  "reason": "one sentence justifying the decision"
}`;

function buildUserPrompt(input: GateInput): string {
	const parts: string[] = [];
	if (input.projectName) {
		parts.push(`Project: ${input.projectName}`);
	}
	if (input.priorContext) {
		parts.push(`Prior context (for grounding only, not to capture):\n${input.priorContext}`);
	}
	parts.push(`User:\n${input.userMessage}`);
	parts.push(`Assistant:\n${input.assistantMessage}`);
	return parts.join("\n\n");
}

function safeParse(raw: string): GateDecision {
	const clean = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const parsed = JSON.parse(clean) as Partial<GateDecision>;
	return {
		should_capture: Boolean(parsed.should_capture),
		content: typeof parsed.content === "string" ? parsed.content.trim() : "",
		suggested_topics: Array.isArray(parsed.suggested_topics)
			? parsed.suggested_topics.filter((t): t is string => typeof t === "string").slice(0, 3)
			: [],
		suggested_type:
			typeof parsed.suggested_type === "string" ? parsed.suggested_type : "observation",
		memory_type:
			parsed.memory_type === "fact" ||
			parsed.memory_type === "preference" ||
			parsed.memory_type === "episodic" ||
			parsed.memory_type === "procedural"
				? parsed.memory_type
				: "episodic",
		reason: typeof parsed.reason === "string" ? parsed.reason : "",
	};
}

export async function relevanceGate(input: GateInput): Promise<GateResult> {
	const userPrompt = buildUserPrompt(input);
	try {
		const { text, usage } = await generateText({
			model: GATE_MODEL,
			maxOutputTokens: 512,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
		});
		const decision = safeParse(text);
		// If the gate said capture but produced empty content, treat as a skip.
		if (decision.should_capture && !decision.content) {
			decision.should_capture = false;
			decision.reason = decision.reason || "gate marked capture but returned empty content";
		}
		return {
			decision,
			usage: {
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
			},
		};
	} catch (err) {
		// Fail closed: never capture on error, never crash the caller.
		return {
			decision: {
				should_capture: false,
				content: "",
				suggested_topics: [],
				suggested_type: "observation",
				memory_type: "episodic",
				reason: `gate error: ${(err as Error).message}`,
			},
			usage: { inputTokens: 0, outputTokens: 0 },
		};
	}
}

// Haiku 4.5 pricing (USD per million tokens). Update if Anthropic changes rates.
const HAIKU_INPUT_PER_M = 1.0;
const HAIKU_OUTPUT_PER_M = 5.0;

export function estimateUsd(inputTokens: number, outputTokens: number): number {
	return (
		(inputTokens / 1_000_000) * HAIKU_INPUT_PER_M + (outputTokens / 1_000_000) * HAIKU_OUTPUT_PER_M
	);
}
