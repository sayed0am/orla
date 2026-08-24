import type { WranglerBin } from "./provision.d.mts";
import type { Runner } from "./run.d.mts";

export interface DirOptions {
	dir: string;
}

export interface WranglerStepOptions extends DirOptions {
	wranglerBin: WranglerBin;
}

export const D1_BINDING: string;

export function npmCi(
	runner: Runner,
	options: DirOptions,
): Promise<{ ok: boolean; stdout: string; stderr: string }>;

export function npmBuild(
	runner: Runner,
	options: DirOptions,
): Promise<{ ok: boolean; stdout: string; stderr: string }>;

export function applyMigrations(
	runner: Runner,
	options: WranglerStepOptions,
): Promise<{ ok: boolean; stdout: string; stderr: string }>;

export type DeployResult =
	| { ok: true; url: string; stdout: string }
	| { ok: false; stdout: string; stderr: string };

export function deploy(
	runner: Runner,
	options: { dir: string; wranglerBin: WranglerBin },
): Promise<DeployResult>;
