import type { Runner } from "./run.d.mts";

export interface WranglerBin {
	command: string;
	args: string[];
}

export interface ProvisionOptions {
	dir: string;
	wranglerBin: WranglerBin;
	workerName: string;
	assistantName: string;
	vapidSubject: string;
	vapidPublicKey: string;
}

export type ProvisionResult =
	| { ok: true; databaseId: string }
	| { ok: false; stderr: string; stdout: string };

export function provision(runner: Runner, options: ProvisionOptions): Promise<ProvisionResult>;
