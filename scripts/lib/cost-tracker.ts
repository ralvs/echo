import { estimateUsd } from "@/lib/relevance-gate";

export type CostSnapshot = {
	inputTokens: number;
	outputTokens: number;
	usd: number;
	gateCalls: number;
	captures: number;
};

export class CostTracker {
	private inputTokens = 0;
	private outputTokens = 0;
	private gateCalls = 0;
	private captures = 0;

	constructor(private readonly maxUsd: number) {}

	record(inputTokens: number, outputTokens: number) {
		this.inputTokens += inputTokens;
		this.outputTokens += outputTokens;
		this.gateCalls += 1;
	}

	recordCapture() {
		this.captures += 1;
	}

	get usd(): number {
		return estimateUsd(this.inputTokens, this.outputTokens);
	}

	overBudget(): boolean {
		return this.usd >= this.maxUsd;
	}

	snapshot(): CostSnapshot {
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			usd: this.usd,
			gateCalls: this.gateCalls,
			captures: this.captures,
		};
	}
}
