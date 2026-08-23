/**
 * History compaction (PRD §5 "Cost discipline": "History compaction is rare and deliberate
 * (size-threshold triggered), accepting one cache rebuild"). Pure message-building and
 * output-validation helpers — the size check, the `completeJson` call, and persistence all live in
 * `Conversation#send` (src/conversation.ts), which is the only caller.
 *
 * Compaction folds the oldest non-compacted turns (everything except the most recent
 * `KEEP_RECENT_TURNS`) into a single running summary, folding in any prior summary so nothing is
 * lost across repeated compactions. The summary is rendered by `buildMessages` (src/prompt.ts) as
 * one more cached system part between the memory block and the live history — so between
 * compactions the cached prefix only grows by appending, exactly one cache rebuild per compaction.
 */

import type { ChatMessage } from "./prompt";

/** Rough size trigger: chars, not tokens (~4 chars ≈ 1 token) — cheap to compute, no tokenizer. */
export const COMPACTION_THRESHOLD_CHARS = 48_000;

/** Turns kept verbatim (never folded into the summary) on any given compaction. */
export const KEEP_RECENT_TURNS = 8;

/**
 * Static, deterministic system prompt for the compaction call. No dates or randomness — sent with
 * `cache_control` so it doesn't compete with the main chat system prompt's own cache entry, but
 * still amortizes across every compaction call.
 */
export const COMPACTION_SYSTEM_PROMPT = [
	"You summarize the earlier part of an ongoing chat conversation so it can be dropped from the " +
		"prompt while preserving what matters.",
	"You will receive a JSON object with `previous_summary` (a prior summary of even earlier turns, " +
		"or null if this is the first compaction of this conversation) and `turns` (an array of " +
		"{role, content} chat turns, oldest first, being folded into the summary now).",
	"When `previous_summary` is not null, fold it in: the new summary must cover everything still " +
		"relevant from `previous_summary` plus everything relevant in `turns`, not just the new " +
		"turns alone.",
	"Return ONLY a single JSON object, with no prose before or after it, of the exact shape " +
		'{"summary": string}.',
	'Write the summary in the third person (e.g. "The user asked about...", never "I" or "you").',
	"Preserve: decisions made, open questions left unresolved, named entities (people, places, " +
		"projects), dates and times mentioned, and any preferences the user stated about how they " +
		"want to be helped.",
	"Never invent information that is not present in `previous_summary` or `turns`.",
	"Keep the summary to at most 1500 characters.",
].join("\n");

export type CompactionTurn = { role: "user" | "assistant"; content: string };

export type CompactionInput = {
	/** The conversation's existing summary text, or `null` if none has been produced yet. */
	previous_summary: string | null;
	/** Oldest-first turns being folded into the summary on this compaction. */
	turns: CompactionTurn[];
};

export type CompactionOutput = { summary: string };

function cachedSystemMessage(text: string): ChatMessage {
	return {
		role: "system",
		content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
	};
}

/** Builds the (uncached) messages for the compaction `completeJson` call. */
export function buildCompactionMessages(input: CompactionInput): ChatMessage[] {
	return [
		cachedSystemMessage(COMPACTION_SYSTEM_PROMPT),
		{
			role: "user",
			content: JSON.stringify({
				previous_summary: input.previous_summary,
				turns: input.turns,
			}),
		},
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Hand-rolled validation of the compaction call's output — never trust raw model JSON. */
export function normalizeCompactionOutput(value: unknown): CompactionOutput | null {
	if (!isRecord(value) || typeof value.summary !== "string" || value.summary.trim().length === 0) {
		return null;
	}
	return { summary: value.summary };
}
