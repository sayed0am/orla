import { describe, expect, it } from "vitest";
import {
	buildCompactionMessages,
	COMPACTION_SYSTEM_PROMPT,
	type CompactionTurn,
	normalizeCompactionOutput,
} from "../src/compaction";
import type { ContentPart } from "../src/prompt";

describe("buildCompactionMessages", () => {
	const turns: CompactionTurn[] = [
		{ role: "user", content: "what's the capital of France?" },
		{ role: "assistant", content: "Paris." },
	];

	it("builds a cached system message followed by one user message", () => {
		const messages = buildCompactionMessages({ previous_summary: null, turns });

		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]?.role).toBe("user");
	});

	it("uses the static COMPACTION_SYSTEM_PROMPT text with cache_control set", () => {
		const messages = buildCompactionMessages({ previous_summary: null, turns });
		const systemContent = messages[0]?.content as ContentPart[];

		expect(Array.isArray(systemContent)).toBe(true);
		expect(systemContent[0]?.text).toBe(COMPACTION_SYSTEM_PROMPT);
		expect(systemContent[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("encodes previous_summary and turns as JSON in the user message", () => {
		const messages = buildCompactionMessages({ previous_summary: "earlier stuff", turns });
		const parsed = JSON.parse(messages[1]?.content as string) as {
			previous_summary: string | null;
			turns: CompactionTurn[];
		};

		expect(parsed.previous_summary).toBe("earlier stuff");
		expect(parsed.turns).toEqual(turns);
	});

	it("encodes a null previous_summary as JSON null, not the string 'null'", () => {
		const messages = buildCompactionMessages({ previous_summary: null, turns });
		const parsed = JSON.parse(messages[1]?.content as string) as { previous_summary: unknown };
		expect(parsed.previous_summary).toBeNull();
	});

	it("is deterministic for the same input", () => {
		const a = buildCompactionMessages({ previous_summary: "x", turns });
		const b = buildCompactionMessages({ previous_summary: "x", turns });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("normalizeCompactionOutput", () => {
	it("accepts a valid { summary: string } object", () => {
		expect(normalizeCompactionOutput({ summary: "The user discussed a trip." })).toEqual({
			summary: "The user discussed a trip.",
		});
	});

	it("rejects a missing summary field", () => {
		expect(normalizeCompactionOutput({})).toBeNull();
	});

	it("rejects a non-string summary", () => {
		expect(normalizeCompactionOutput({ summary: 123 })).toBeNull();
	});

	it("rejects an empty or whitespace-only summary", () => {
		expect(normalizeCompactionOutput({ summary: "" })).toBeNull();
		expect(normalizeCompactionOutput({ summary: "   " })).toBeNull();
	});

	it("rejects non-object values", () => {
		expect(normalizeCompactionOutput(null)).toBeNull();
		expect(normalizeCompactionOutput("a string")).toBeNull();
		expect(normalizeCompactionOutput(42)).toBeNull();
		expect(normalizeCompactionOutput(undefined)).toBeNull();
	});
});
