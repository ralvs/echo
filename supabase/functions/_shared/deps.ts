import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ai } from "./model.ts";

/**
 * The two runtime dependencies every shared workflow crosses: the database
 * and the model-call seam. Each runtime constructs this once (from its own
 * env/config) and passes it in; shared code never reads the environment.
 */
export type EchoDeps = {
	db: SupabaseClient;
	ai: Ai;
};
