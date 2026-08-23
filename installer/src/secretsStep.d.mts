import type { WranglerBin } from "./provision.d.mts";
import type { Runner } from "./run.d.mts";

export const SECRET_NAMES: readonly string[];

export interface PutSecretsOptions {
	wranglerBin: WranglerBin;
	workerName: string;
	values: Record<string, string>;
}

export interface PutSecretsResultEntry {
	name: string;
	ok: boolean;
	stderr: string;
}

export type PutSecretsResult =
	| { ok: true; results: PutSecretsResultEntry[] }
	| { ok: false; failedAt: string; results: PutSecretsResultEntry[] };

export function putSecrets(runner: Runner, options: PutSecretsOptions): Promise<PutSecretsResult>;
