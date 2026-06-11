/**
 * Binding of the shared relevance gate (@shared/relevance-gate.ts) to this
 * runtime's model-call adapter. Hooks and the mine CLI import from here.
 */

import * as shared from "@shared/relevance-gate.ts";
import { nodeAi } from "./model";

export type { GateDecision, GateInput, GateResult } from "@shared/relevance-gate.ts";
export { estimateUsd } from "@shared/relevance-gate.ts";

export const relevanceGate = (input: shared.GateInput) => shared.relevanceGate(nodeAi, input);
