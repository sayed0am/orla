export function parseD1CreateOutput(stdout: string): {
	databaseId: string;
	databaseName: string | null;
};
export function parseDeployUrl(stdout: string): string;
export function parseWhoami(stdout: string): {
	loggedIn: boolean;
	email: string | null;
	accounts: Array<{ id: string; name: string }>;
};
