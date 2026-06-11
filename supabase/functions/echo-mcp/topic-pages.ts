/**
 * Bindings of the shared topic-page lifecycle (../_shared/topic-pages.ts)
 * to this runtime's DB client and model-call adapter.
 */

import * as shared from "../_shared/topic-pages.ts";
import { supabase } from "./config.ts";
import { ai } from "./model.ts";

export const recompileTopicPage = (pageId: string) =>
	shared.recompileTopicPage({ db: supabase, ai }, pageId);
