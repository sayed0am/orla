import { describe, expect, it } from "vitest";
import { buildMessages, type ContentPart, systemPrompt } from "../src/prompt";

function baseInput() {
	return {
		assistantName: "Orla",
		memoryBlock: "The user prefers concise answers.",
		history: [
			{ role: "user" as const, content: "hey" },
			{ role: "assistant" as const, content: "hi there" },
		],
		userMessage: "what's on my plate today?",
	};
}

describe("systemPrompt", () => {
	it("contains the assistant name", () => {
		expect(systemPrompt("Orla")).toContain("Orla");
		expect(systemPrompt("Jarvis")).toContain("Jarvis");
	});

	it("is deterministic for the same name", () => {
		expect(systemPrompt("Orla")).toBe(systemPrompt("Orla"));
	});
});

describe("buildMessages ordering", () => {
	it("orders system -> memory -> history -> final user message", () => {
		const messages = buildMessages(baseInput());

		expect(messages).toHaveLength(5);
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]?.role).toBe("system");
		expect(messages[2]).toEqual({ role: "user", content: "hey" });
		expect(messages[3]).toEqual({ role: "assistant", content: "hi there" });
		expect(messages[4]?.role).toBe("user");
	});

	it("omits the memory message entirely when memoryBlock is empty", () => {
		const messages = buildMessages({ ...baseInput(), memoryBlock: "" });

		expect(messages).toHaveLength(4);
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]).toEqual({ role: "user", content: "hey" });
	});

	it("places cache_control only on the system and memory parts", () => {
		const messages = buildMessages(baseInput());

		const systemContent = messages[0]?.content;
		const memoryContent = messages[1]?.content;
		expect(Array.isArray(systemContent)).toBe(true);
		expect(Array.isArray(memoryContent)).toBe(true);
		expect((systemContent as ContentPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect((memoryContent as ContentPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// History and final message are plain strings — no cache_control possible on them.
		for (const message of messages.slice(2)) {
			expect(typeof message.content).toBe("string");
		}
	});
});

describe("buildMessages cache-prefix stability", () => {
	function prefixOf(messages: ReturnType<typeof buildMessages>) {
		return JSON.stringify(messages.slice(0, -1));
	}

	it("keeps the prefix byte-identical across calls with different now/dynamicContext", () => {
		const a = buildMessages({
			...baseInput(),
			dynamicContext: "note: it's raining",
			now: new Date("2026-01-01T00:00:00Z"),
		});
		const b = buildMessages({
			...baseInput(),
			dynamicContext: "note: totally different context, much longer text here",
			now: new Date("2026-08-22T12:34:56Z"),
		});

		expect(prefixOf(a)).toBe(prefixOf(b));
		// Sanity check the prefixes aren't trivially both-empty.
		expect(JSON.parse(prefixOf(a))).toHaveLength(4);
	});

	it("keeps the prefix identical whether or not dynamicContext/now are supplied at all", () => {
		const withContext = buildMessages({
			...baseInput(),
			dynamicContext: "some retrieved notes",
			now: new Date("2026-01-01T00:00:00Z"),
		});
		const withoutContext = buildMessages(baseInput());

		expect(prefixOf(withContext)).toBe(prefixOf(withoutContext));
	});

	it("puts the timestamp and dynamic context only in the last message", () => {
		const now = new Date("2026-08-22T12:34:56.000Z");
		const messages = buildMessages({
			...baseInput(),
			dynamicContext: "retrieved: it's your sister's birthday",
			now,
		});

		const last = messages[messages.length - 1];
		expect(last?.content).toContain("retrieved: it's your sister's birthday");
		expect(last?.content).toContain(now.toISOString());
		expect(last?.content).toContain("what's on my plate today?");

		for (const message of messages.slice(0, -1)) {
			const text = JSON.stringify(message.content);
			expect(text).not.toContain(now.toISOString());
			expect(text).not.toContain("retrieved: it's your sister's birthday");
		}
	});

	it("does not append a <context> block when dynamicContext is absent", () => {
		const messages = buildMessages(baseInput());
		const last = messages[messages.length - 1];
		expect(last?.content).toBe("what's on my plate today?");
		expect(last?.content).not.toContain("<context>");
	});
});
