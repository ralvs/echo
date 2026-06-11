/**
 * Bindings of the shared entity-page lifecycle (../_shared/entity-pages.ts)
 * to this runtime's DB client and model-call adapter.
 */

import * as shared from "../_shared/entity-pages.ts";
import { supabase } from "./config.ts";
import { ai } from "./model.ts";

export const recompileEntityPage = (entityId: string) =>
	shared.recompileEntityPage({ db: supabase, ai }, entityId);
