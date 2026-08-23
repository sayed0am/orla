export const STEP_ORDER: readonly string[];
export const STEP_LABELS: Readonly<Record<string, string>>;
export function resolveStepIndex(step: string): number;
export function stepsToRun(fromStep?: string): string[];
