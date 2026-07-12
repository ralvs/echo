/**
 * Bindings of the shared people module (../_shared/people.ts) to this
 * runtime's DB client and model-call adapter.
 */

import * as shared from "../_shared/people.ts";
import { ECHO_OWNER_NAME, supabase } from "./config.ts";
import { ai } from "./model.ts";

export type { PersonDefinition, PersonRecord } from "../_shared/types.ts";

export const getKnownPeople = () => shared.getKnownPeople(supabase);

export const upsertPerson = (canonicalName: string, role: string) =>
	shared.upsertPerson(supabase, canonicalName, role);

export const backfillPersonAlias = (alias: string, canonicalName: string) =>
	shared.backfillPersonAlias(
		{ db: supabase, ai, ownerName: ECHO_OWNER_NAME },
		alias,
		canonicalName,
	);
