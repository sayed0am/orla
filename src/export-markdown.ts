/**
 * Renders a full-account export (PRD §7 Portability) as one Markdown document, for humans rather
 * than an LLM prompt — private content is included verbatim (see `## Journal` and `## Raw notes`).
 *
 * The data layer (`src/journal.ts`) has no notion of Durable Objects, so conversation turns are
 * fetched by the caller (`src/routes/journal.ts`'s `handleExport`) and passed in already resolved.
 */

export type ExportMemoryFact = {
	text: string;
	status: "proposed" | "active" | "archived";
};

export type ExportActionItem = {
	text: string;
	due_date: string | null;
	status: string;
	summary: string;
};

export type ExportJournalEntry = {
	type: string;
	summary: string;
	cleaned_text: string;
	tags: string[];
	attendees: string[];
	decisions: string[];
	captured_at: string;
};

export type ExportRawNote = {
	created_at: string;
	private: boolean;
	body: string;
};

export type ExportTurn = {
	role: string;
	content: string;
};

export type ExportConversation = {
	id: string;
	title: string;
	turns: ExportTurn[];
	/** Set when the conversation's Durable Object couldn't be reached (see `handleExport`'s
	 * per-conversation `try/catch`) — the export still lists the conversation, just without its
	 * turns, rather than failing the whole export over one unreachable DO. */
	unavailable?: boolean;
};

export type ExportData = {
	memory_facts: ExportMemoryFact[];
	action_items: ExportActionItem[];
	journal: ExportJournalEntry[];
	raw_notes: ExportRawNote[];
	conversations: ExportConversation[];
};

/**
 * Blockquotes `text` line by line so a body containing `\n### something` can never be mistaken for
 * a Markdown heading: a blockquote prefix only on the first line would leave later lines of a
 * multi-line body outside the quote, where a stray `### ` would render as a real heading.
 */
function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function dayOf(isoTimestamp: string): string {
	return isoTimestamp.slice(0, 10);
}

function renderMemoryFacts(lines: string[], facts: ExportMemoryFact[]): void {
	const active = facts.filter((f) => f.status === "active");
	const proposed = facts.filter((f) => f.status === "proposed");
	const archived = facts.filter((f) => f.status === "archived");

	lines.push("## Memory facts (active)");
	lines.push("");
	if (active.length === 0) {
		lines.push("(none)");
	} else {
		for (const fact of active) {
			lines.push(`- ${fact.text}`);
		}
	}

	if (proposed.length > 0) {
		lines.push("");
		lines.push("### Proposed");
		lines.push("");
		for (const fact of proposed) {
			lines.push(`- ${fact.text}`);
		}
	}

	if (archived.length > 0) {
		lines.push("");
		lines.push("### Archived");
		lines.push("");
		for (const fact of archived) {
			lines.push(`- ${fact.text}`);
		}
	}
}

/** Open and done items only — dismissed items are noise the user has already discarded. */
function renderActionItems(lines: string[], items: ExportActionItem[]): void {
	lines.push("## Action items (open)");
	lines.push("");

	const visible = items.filter((item) => item.status !== "dismissed");
	if (visible.length === 0) {
		lines.push("(none)");
		return;
	}

	const sorted = [...visible].sort((a, b) => {
		if (a.due_date === b.due_date) {
			return 0;
		}
		if (a.due_date === null) {
			return 1;
		}
		if (b.due_date === null) {
			return -1;
		}
		return a.due_date < b.due_date ? -1 : 1;
	});

	for (const item of sorted) {
		const checkbox = item.status === "done" ? "[x]" : "[ ]";
		const due = item.due_date ? ` — due ${item.due_date}` : "";
		lines.push(`- ${checkbox} ${item.text}${due} (${item.summary})`);
	}
}

function renderJournalEntry(lines: string[], entry: ExportJournalEntry): void {
	lines.push(`**${entry.type}** · ${entry.summary}`);
	if (entry.tags.length > 0) {
		lines.push("");
		lines.push(entry.tags.map((tag) => `#${tag}`).join(" "));
	}
	lines.push("");
	lines.push(blockquote(entry.cleaned_text));
	if (entry.type === "meeting") {
		if (entry.attendees.length > 0) {
			lines.push("");
			lines.push(`Attendees: ${entry.attendees.join(", ")}`);
		}
		if (entry.decisions.length > 0) {
			lines.push("");
			lines.push(`Decisions: ${entry.decisions.join(", ")}`);
		}
	}
}

function renderJournal(
	lines: string[],
	journal: ExportJournalEntry[],
	rawNotes: ExportRawNote[],
): void {
	lines.push("## Journal");

	const privateNotes = rawNotes.filter((n) => n.private);
	const days = new Set<string>();
	for (const entry of journal) {
		days.add(dayOf(entry.captured_at));
	}
	for (const note of privateNotes) {
		days.add(dayOf(note.created_at));
	}

	const sortedDays = [...days].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

	if (sortedDays.length === 0) {
		lines.push("");
		lines.push("(no captured days yet)");
		return;
	}

	for (const day of sortedDays) {
		lines.push("");
		lines.push(`### ${day}`);

		const entriesForDay = journal
			.filter((entry) => dayOf(entry.captured_at) === day)
			.sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1));
		for (const entry of entriesForDay) {
			lines.push("");
			renderJournalEntry(lines, entry);
		}

		const notesForDay = privateNotes.filter((note) => dayOf(note.created_at) === day);
		for (const note of notesForDay) {
			lines.push("");
			lines.push("**raw (private)**");
			lines.push("");
			lines.push(blockquote(note.body));
		}
	}
}

/** Every raw note, canonical source of truth — flattened to one line each. */
function renderRawNotes(lines: string[], rawNotes: ExportRawNote[]): void {
	lines.push("## Raw notes");
	lines.push("");

	if (rawNotes.length === 0) {
		lines.push("(none)");
		return;
	}

	for (const note of rawNotes) {
		const flatBody = note.body.replace(/\s+/g, " ").trim();
		const privateTag = note.private ? " [private]" : "";
		lines.push(`- ${note.created_at}${privateTag} ${flatBody}`);
	}
}

function renderConversations(lines: string[], conversations: ExportConversation[]): void {
	lines.push("## Conversations");

	if (conversations.length === 0) {
		lines.push("");
		lines.push("(no conversations yet)");
		return;
	}

	for (const conversation of conversations) {
		lines.push("");
		lines.push(`### ${conversation.title || conversation.id}`);

		if (conversation.unavailable) {
			lines.push("");
			lines.push("_(turns unavailable)_");
			continue;
		}

		if (conversation.turns.length === 0) {
			lines.push("");
			lines.push("(no messages)");
			continue;
		}

		for (const turn of conversation.turns) {
			lines.push("");
			lines.push(`**${turn.role}:**`);
			lines.push("");
			lines.push(blockquote(turn.content));
		}
	}
}

/** Renders the full export as one Markdown document (PRD §7 Portability). */
export function renderExportMarkdown(data: ExportData, exportedAt: string): string {
	const lines: string[] = [`# Orla export — ${exportedAt}`, ""];

	renderMemoryFacts(lines, data.memory_facts);
	lines.push("");
	renderActionItems(lines, data.action_items);
	lines.push("");
	renderJournal(lines, data.journal, data.raw_notes);
	lines.push("");
	renderRawNotes(lines, data.raw_notes);
	lines.push("");
	renderConversations(lines, data.conversations);

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}
