/**
 * Bindings of the shared LLM functions (@shared/ai.ts) to this runtime's
 * model-call adapter. Next.js code imports from here so it never threads
 * the adapter itself.
 */

import * as shared from "@shared/ai.ts";
import type { PersonRecord } from "@shared/types.ts";
import { nodeAi } from "./model";

export type { ExtractedMetadata } from "@shared/ai.ts";
export { buildEmbeddingText } from "@shared/ai.ts";

export const getEmbedding = (text: string): Promise<number[]> => nodeAi.embed(text);

export const extractMetadata = (text: string, knownPeople: PersonRecord[] = []) =>
	shared.extractMetadata(nodeAi, text, knownPeople);
