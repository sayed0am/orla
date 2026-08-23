import type { CaptureResult, Runner } from "./run.d.mts";

export const ORLA_REPO_URL: string;

export function isExistingOrlaCheckout(dir: string): boolean;
export function cloneOrReuse(
	runner: Runner,
	options: { ref: string; dir: string },
): Promise<CaptureResult>;
