/**
 * Binding of the shared Capture pipeline (@shared/capture.ts) to this
 * runtime's DB client and model-call adapter. The API route passes Next's
 * after() as the background scheduler so compounding side effects survive
 * the response.
 */

import {
	type CaptureInput,
	type CaptureResult,
	captureThought as runCapture,
} from "@shared/capture.ts";
import { nodeAi } from "./model";
import { createServiceClient } from "./supabase";

export type { CaptureInput, CaptureResult };

const DECOMPOSE_MIN_TOKENS = Number(process.env.DECOMPOSE_MIN_TOKENS || "200");
const DECOMPOSE_ENABLED = process.env.DECOMPOSE_ENABLED !== "false";

export function captureThought(
	input: CaptureInput,
	background?: (work: Promise<unknown>) => void,
): Promise<CaptureResult> {
	return runCapture(
		{ db: createServiceClient(), ai: nodeAi, ownerName: process.env.ECHO_OWNER_NAME ?? null },
		input,
		{
			source: "echo",
			decompose: DECOMPOSE_ENABLED,
			decomposeMinTokens: DECOMPOSE_MIN_TOKENS,
			background,
		},
	);
}
