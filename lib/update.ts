/**
 * Binding of the shared Update workflow (@shared/update.ts) to this
 * runtime's DB client and model-call adapter. The API route passes Next's
 * after() as the background scheduler so compounding side effects survive
 * the response.
 */

import { updateThought as runUpdate, type UpdateInput, type UpdateResult } from "@shared/update.ts";
import { nodeAi } from "./model";
import { createServiceClient } from "./supabase";

export type { UpdateInput, UpdateResult };

export function updateThought(
	id: string,
	input: UpdateInput,
	background?: (work: Promise<unknown>) => void,
): Promise<UpdateResult> {
	return runUpdate({ db: createServiceClient(), ai: nodeAi }, id, input, {
		source: "echo",
		background,
	});
}
