/**
 * Bindings of the shared LLM functions (../_shared/ai.ts) to this runtime's
 * model-call adapter. Tool files import from here so they never thread the
 * adapter themselves.
 */

import * as shared from "../_shared/ai.ts";
import type { PersonRecord } from "../_shared/types.ts";
import { ai } from "./model.ts";

export type { ExtractedMetadata } from "../_shared/ai.ts";
export { buildEmbeddingText, identifyTopicPage } from "../_shared/ai.ts";

export const getEmbedding = (text: string): Promise<number[]> => ai.embed(text);

export const extractMetadata = (text: string, knownPeople: PersonRecord[] = []) =>
	shared.extractMetadata(ai, text, knownPeople);

export const classifyRelation = (newText: string, existingText: string) =>
	shared.classifyRelation(ai, newText, existingText);

export const compileTopicPage = (
	title: string,
	existingSummary: string | null,
	newThoughts: { content: string; created_at: string; memory_type?: string }[],
) => shared.compileTopicPage(ai, title, existingSummary, newThoughts);

export const compileEntityPage = (
	name: string,
	entityType: string,
	thoughts: { content: string; created_at: string }[],
	related: { name: string; type: string; weight: number }[],
) => shared.compileEntityPage(ai, name, entityType, thoughts, related);

export const detectContradictions = (facts: { id: string; content: string; topics: string[] }[]) =>
	shared.detectContradictions(ai, facts);

export const decomposeWithLLM = (text: string) => shared.decomposeWithLLM(ai, text);
