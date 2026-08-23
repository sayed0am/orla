export function printChecklistHeader(): void;
export function printStepStart(step: string): void;
export function printStepDone(step: string): void;
export function buildResumeCommand(argv: string[], step: string, dir?: string): string;
export function printStepFailed(step: string, detail?: string, dir?: string): void;
export function printError(message: string): void;
