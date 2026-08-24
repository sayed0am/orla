/**
 * Typed SSE reader for the chat stream (`POST /api/conversations/:id/messages`). Ported from
 * `public/chat.js`'s `parseEventBlock` + `readSse`, byte-identical block-parsing semantics, plus
 * per-event JSON decoding into a discriminated union — see `src/conversation.ts`'s `sseEvent()`
 * call sites for the exact payload shapes each event name carries on the wire.
 */

/** One `event: <name>\ndata: <json>\n\n` block, already decoded into a typed payload. */
export type SseEvent =
	| { event: "delta"; text: string }
	| { event: "tool"; id: string; name: string; status: "done" | "error"; preview: string }
	| { event: "confirm"; action_id: string; name: string; arguments: Record<string, unknown> }
	| { event: "reminder"; id: string; text: string; fire_at: string }
	| { event: "done"; usage: unknown }
	| { event: "error"; message: string };

interface RawEvent {
	event: string;
	data: string;
}

/**
 * Parses one SSE event block (lines already split, blank-line separated) into `{ event, data }`.
 * `event` defaults to "message" per the SSE spec.
 */
function parseEventBlock(block: string): RawEvent {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("event:")) {
			event = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trim());
		}
	}
	return { event, data: dataLines.join("\n") };
}

/**
 * Decodes one raw `{event, data}` block into a typed `SseEvent`, mirroring the per-event-name
 * JSON parsing chat.js does inline in its stream callback. Returns `null` for an event name this
 * union doesn't model (chat.js silently ignores those too) or a `tool`/`confirm` block whose data
 * isn't valid JSON (chat.js swallows that parse error and skips the chip/card).
 */
function toSseEvent(raw: RawEvent): SseEvent | null {
	switch (raw.event) {
		case "delta": {
			// The server always sends a JSON-encoded string; fall back to the raw text (matching
			// chat.js) if it somehow isn't parseable, and accept a `{ text }` shape defensively too.
			let delta: unknown;
			try {
				delta = JSON.parse(raw.data);
			} catch {
				delta = raw.data;
			}
			const text =
				typeof delta === "string"
					? delta
					: typeof (delta as { text?: unknown })?.text === "string"
						? ((delta as { text: string }).text ?? "")
						: "";
			return { event: "delta", text };
		}
		case "tool": {
			try {
				const data = JSON.parse(raw.data) as {
					id: string;
					name: string;
					status: "done" | "error";
					preview: string;
				};
				return { event: "tool", ...data };
			} catch {
				return null;
			}
		}
		case "confirm": {
			try {
				const data = JSON.parse(raw.data) as {
					action_id: string;
					name: string;
					arguments: Record<string, unknown>;
				};
				return { event: "confirm", ...data };
			} catch {
				return null;
			}
		}
		case "reminder": {
			try {
				const data = JSON.parse(raw.data) as { id: string; text: string; fire_at: string };
				return { event: "reminder", ...data };
			} catch {
				return null;
			}
		}
		case "done": {
			try {
				const data = JSON.parse(raw.data) as { usage: unknown };
				return { event: "done", usage: data.usage };
			} catch {
				return null;
			}
		}
		case "error": {
			let message: string;
			try {
				message = (JSON.parse(raw.data) as { message?: string }).message ?? "stream error";
			} catch {
				message = "stream error";
			}
			return { event: "error", message };
		}
		default:
			return null;
	}
}

/**
 * Reads an SSE `Response` body, invoking `onEvent` for each decoded event. Byte-identical
 * block-reading loop to chat.js's `readSse`: buffers decoded chunks and dispatches on every
 * `\n\n` separator, ignoring blank blocks.
 */
export async function readSse(res: Response, onEvent: (event: SseEvent) => void): Promise<void> {
	if (!res.body) {
		return;
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });

		let sepIndex = buffer.indexOf("\n\n");
		while (sepIndex !== -1) {
			const block = buffer.slice(0, sepIndex);
			buffer = buffer.slice(sepIndex + 2);
			if (block.trim().length > 0) {
				const event = toSseEvent(parseEventBlock(block));
				if (event) {
					onEvent(event);
				}
			}
			sepIndex = buffer.indexOf("\n\n");
		}
	}
}
