/** Type declarations for outbox.js — see that file for behavior notes. */

/** An item queued for capture, as created by the capture screen and stored in the outbox. */
export interface OutboxItem {
	client_id: string;
	body: string;
	private: boolean;
	created_at: string;
}

/** An outbox item that was poisoned by a non-auth 4xx response from the API. */
export interface FailedOutboxItem extends OutboxItem {
	failed_reason: string;
	failed_at: string;
}

/** Result of a flush pass over the pending outbox. */
export interface FlushResult {
	sent: number;
	failed: number;
	remaining: number;
}

/** Adds an item to the pending outbox. */
export function addToOutbox(item: OutboxItem): Promise<void>;

/** Lists every pending outbox item. */
export function listOutbox(): Promise<OutboxItem[]>;

/** Removes an item from the pending outbox by client_id. */
export function removeFromOutbox(clientId: string): Promise<void>;

/** Moves a poisoned item (rejected by the API with a non-auth 4xx) into the failed store. */
export function moveToFailed(item: OutboxItem, reason: string): Promise<void>;

/** Lists every failed (poisoned) outbox item. */
export function listFailed(): Promise<FailedOutboxItem[]>;

/**
 * Flushes the outbox: POSTs each pending item to /api/notes.
 *
 * - 2xx: delete from outbox (success, including idempotent re-send).
 * - 4xx other than 401/403/429: poison — move to the failed store, drop from outbox, log.
 * - 401/403/429, network error, or 5xx: leave in the outbox for the next flush.
 */
export function flushOutbox(fetchImpl?: typeof fetch): Promise<FlushResult>;
