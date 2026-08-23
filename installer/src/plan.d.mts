export interface PlanOptions {
	wranglerVersion: string;
	ref?: string;
	dir?: string;
	workerName?: string;
	pinZdr?: boolean;
}

export interface PlanStep {
	step: string;
	commands: string[];
}

export function buildPlan(opts: PlanOptions): PlanStep[];
export function formatPlan(plan: PlanStep[]): string;
