export interface CaptureOptions {
	cwd?: string;
	input?: string;
	env?: NodeJS.ProcessEnv;
}

export interface CaptureResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface InteractiveResult {
	code: number | null;
}

export interface Runner {
	capture(command: string, args: string[], options?: CaptureOptions): Promise<CaptureResult>;
	interactive(
		command: string,
		args: string[],
		options?: Omit<CaptureOptions, "input">,
	): Promise<InteractiveResult>;
}

export function capture(
	command: string,
	args: string[],
	options?: CaptureOptions,
): Promise<CaptureResult>;
export function interactive(
	command: string,
	args: string[],
	options?: Omit<CaptureOptions, "input">,
): Promise<InteractiveResult>;
export function createRealRunner(): Runner;
