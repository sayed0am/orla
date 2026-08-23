export function setJsonStringField(
	source: string,
	key: string,
	value: string,
	options?: { all?: boolean },
): string;

export function applyProvisioning(
	source: string,
	fields?: {
		workerName?: string;
		databaseId?: string;
		databaseName?: string;
		assistantName?: string;
		vapidSubject?: string;
		vapidPublicKey?: string;
		llmProvider?: string;
	},
): string;

export function looksLikeOrlaCheckout(wranglerJsonc: string): boolean;
