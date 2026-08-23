import type { WranglerBin } from "./provision.d.mts";
import type { Runner } from "./run.d.mts";

export const MIN_NODE_MAJOR: number;

export function checkNodeVersion(versionString?: string): { ok: boolean; major: number };
export function checkGitPresent(runner: Runner): Promise<{ ok: boolean }>;
export function checkCloudflareLogin(
	runner: Runner,
	wranglerBin: WranglerBin,
): Promise<{
	loggedIn: boolean;
	email: string | null;
	accounts: Array<{ id: string; name: string }>;
}>;
export function login(runner: Runner, wranglerBin: WranglerBin): Promise<{ ok: boolean }>;
