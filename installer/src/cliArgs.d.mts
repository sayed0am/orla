export interface ParsedArgs {
	yes: boolean;
	dryRun: boolean;
	help: boolean;
	ref: string;
	dir: string | undefined;
	from: string | undefined;
	assistantName: string | undefined;
	workerName: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs;
export const HELP_TEXT: string;
