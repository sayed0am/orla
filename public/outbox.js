/**
 * IndexedDB-backed outbox for offline-first note capture (PRD F2, G1).
 *
 * Pure module — importable from both `window` (capture.js) and the service worker
 * (sw.js, as an ES module). No DOM references here.
 */

const DB_NAME = "orla-outbox";
const DB_VERSION = 1;
const STORE_PENDING = "orla-outbox";
const STORE_FAILED = "orla-failed";

/** @returns {Promise<IDBDatabase>} */
function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_PENDING)) {
				db.createObjectStore(STORE_PENDING, { keyPath: "client_id" });
			}
			if (!db.objectStoreNames.contains(STORE_FAILED)) {
				db.createObjectStore(STORE_FAILED, { keyPath: "client_id" });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {"readonly"|"readwrite"} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 */
function withStore(db, storeName, mode, run) {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, mode);
		const store = tx.objectStore(storeName);
		const req = run(store);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** Adds an item to the pending outbox. */
export async function addToOutbox(item) {
	const db = await openDb();
	try {
		await withStore(db, STORE_PENDING, "readwrite", (store) => store.put(item));
	} finally {
		db.close();
	}
}

/** Lists every pending outbox item. */
export async function listOutbox() {
	const db = await openDb();
	try {
		return await withStore(db, STORE_PENDING, "readonly", (store) => store.getAll());
	} finally {
		db.close();
	}
}

/** Removes an item from the pending outbox by client_id. */
export async function removeFromOutbox(clientId) {
	const db = await openDb();
	try {
		await withStore(db, STORE_PENDING, "readwrite", (store) => store.delete(clientId));
	} finally {
		db.close();
	}
}

/** Moves a poisoned item (rejected by the API with a non-auth 4xx) into the failed store. */
export async function moveToFailed(item, reason) {
	const db = await openDb();
	try {
		await withStore(db, STORE_FAILED, "readwrite", (store) =>
			store.put({ ...item, failed_reason: reason, failed_at: new Date().toISOString() }),
		);
		await withStore(db, STORE_PENDING, "readwrite", (store) => store.delete(item.client_id));
	} finally {
		db.close();
	}
}

/** Lists every failed (poisoned) outbox item. */
export async function listFailed() {
	const db = await openDb();
	try {
		return await withStore(db, STORE_FAILED, "readonly", (store) => store.getAll());
	} finally {
		db.close();
	}
}

/**
 * Flushes the outbox: POSTs each pending item to /api/notes.
 *
 * - 2xx: delete from outbox (success, including idempotent re-send).
 * - 4xx other than 401/403/429: poison — move to the failed store, drop from outbox, log.
 * - 401/403/429, network error, or 5xx: leave in the outbox for the next flush.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ sent: number, failed: number, remaining: number }>}
 */
export async function flushOutbox(fetchImpl = fetch) {
	const items = await listOutbox();
	let sent = 0;
	let failed = 0;

	for (const item of items) {
		let res;
		try {
			res = await fetchImpl("/api/notes", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					body: item.body,
					private: item.private,
					client_id: item.client_id,
				}),
			});
		} catch (err) {
			console.error("flushOutbox: network error, leaving item queued", err);
			continue;
		}

		if (res.ok) {
			await removeFromOutbox(item.client_id);
			sent++;
			continue;
		}

		if (res.status === 401 || res.status === 403 || res.status === 429) {
			// Leave queued: auth may recover, or the rate limit will pass.
			continue;
		}

		if (res.status >= 400 && res.status < 500) {
			await moveToFailed(item, `http ${res.status}`);
			failed++;
		}

		// else 5xx: leave queued for retry.
	}

	const remaining = await listOutbox();
	return { sent, failed, remaining: remaining.length };
}
