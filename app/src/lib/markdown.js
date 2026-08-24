/**
 * Streaming-safe markdown renderer for assistant chat replies (inspired by vercel/streamdown,
 * reimplemented vanilla — no React, no dependencies, no build step).
 *
 * Supported subset:
 *  Block:  ATX headings (# .. ######), paragraphs (single "\n" -> <br>, blank line -> new
 *          paragraph), fenced code blocks (``` or ~~~ with optional language), blockquotes (>),
 *          unordered lists (-, *, +) and ordered lists (1.) with one level of nesting via 2+
 *          space indent, horizontal rules (---, ***, or ___), GFM tables (header + |---| row).
 *  Inline: **bold**, italics with * or _, `code`, ~~strike~~, [text](url) (http(s)/mailto only),
 *          bare http(s) autolinks.
 *
 * Security: every text node is escaped via escapeHtml before any tag is emitted. Raw HTML in the
 * source is never passed through. Only http:, https:, and mailto: link targets are honored —
 * anything else (including javascript:) renders as plain text.
 *
 * Streaming: `renderMarkdown(src, { streaming: true })` is called on every delta of a reply that
 * may end mid-construct. The grammar below is written so an incomplete construct simply fails to
 * match and falls back to literal text, which is why streaming and non-streaming share one code
 * path — see the inline stash mechanism and the table/link/code lookaheads.
 */

const STASH_MARK = "\uE000";

export function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function isSafeUrl(url) {
	return /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
}

function splitTableRow(line) {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	const cells = [];
	let cur = "";
	for (let j = 0; j < t.length; j++) {
		const ch = t[j];
		if (ch === "\\" && t[j + 1] === "|") {
			cur += "|";
			j++;
			continue;
		}
		if (ch === "|") {
			cells.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur);
	return cells;
}

function isTableSeparator(line) {
	if (!line?.includes("-")) return false;
	const cells = splitTableRow(line);
	if (cells.length === 0) return false;
	return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function isTableAt(headerLine, sepLine) {
	if (!headerLine.includes("|") || !isTableSeparator(sepLine)) return false;
	return splitTableRow(headerLine).length === splitTableRow(sepLine).length;
}

function alignOf(sepCell) {
	const c = sepCell.trim();
	const left = c.startsWith(":");
	const right = c.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return "";
}

/** Renders inline markdown within one block of raw (unescaped) source text. */
function renderInline(raw) {
	let text = escapeHtml(raw);
	const stash = [];
	const push = (html) => {
		stash.push(html);
		return `${STASH_MARK}${stash.length - 1}${STASH_MARK}`;
	};
	const resolveStashRefs = (s) => s.replace(/\uE000(\d+)\uE000/g, (_, idx) => stash[Number(idx)]);

	// Code spans first: highest precedence, content is never re-parsed.
	text = text.replace(/`([^`\n]+)`/g, (_, code) => push(`<code>${code}</code>`));

	// Explicit links. Missing closing paren (streamed partial link) simply fails to match.
	text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
		if (!isSafeUrl(url)) {
			return whole;
		}
		const safeLabel = resolveStashRefs(label);
		return push(`<a href="${url}" rel="noopener noreferrer" target="_blank">${safeLabel}</a>`);
	});

	// Bare autolinks, trimming trailing sentence punctuation off the URL.
	text = text.replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (whole) => {
		let url = whole;
		let trail = "";
		while (url.length > 0 && /[.,!?;:]$/.test(url)) {
			trail = url.slice(-1) + trail;
			url = url.slice(0, -1);
		}
		if (url.length === 0) {
			return whole;
		}
		return push(`<a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a>`) + trail;
	});

	// Emphasis. An odd/dangling marker at the tail simply never matches and stays literal.
	text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
	text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
	text = text.replace(/_([^_\n]+)_/g, "<em>$1</em>");

	// Hard line breaks (single newline inside a paragraph/line).
	text = text.replace(/\n/g, "<br>\n");

	return resolveStashRefs(text);
}

function isBlockStart(line, nextLine) {
	if (/^ {0,3}(```|~~~)/.test(line)) return true;
	if (/^ {0,3}#{1,6}\s+/.test(line)) return true;
	if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
	if (/^ {0,3}>/.test(line)) return true;
	if (/^ {0,3}([-*+]|\d+\.)\s+/.test(line)) return true;
	if (isTableAt(line, nextLine)) return true;
	return false;
}

function parseList(lines, start, streaming) {
	const markerRe = /^ {0,3}([-*+]|\d+\.)\s+(.*)$/;
	const items = [];
	let ordered = null;
	let startNumber = 1;
	let i = start;

	while (i < lines.length) {
		const m = markerRe.exec(lines[i]);
		if (!m || lines[i].trim() === "") break;
		const isOrderedMarker = /^\d+\.$/.test(m[1]);
		if (ordered === null) {
			ordered = isOrderedMarker;
			if (ordered) startNumber = Number.parseInt(m[1], 10);
		} else if (isOrderedMarker !== ordered) {
			break;
		}
		let itemHtml = renderInline(m[2]);
		i++;

		const nested = [];
		while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
			nested.push(lines[i].replace(/^ {2}/, ""));
			i++;
		}
		if (nested.length > 0) {
			itemHtml += renderMarkdown(nested.join("\n"), { streaming });
		}
		items.push(itemHtml);
	}

	const tag = ordered ? "ol" : "ul";
	const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
	const html = `<${tag}${startAttr}>${items.map((h) => `<li>${h}</li>`).join("")}</${tag}>`;
	return { html, end: i };
}

/**
 * Renders a markdown string to an HTML string.
 * @param {string} src
 * @param {{ streaming?: boolean }} [opts]
 * @returns {string}
 */
export function renderMarkdown(src, opts = {}) {
	const streaming = !!opts.streaming;
	const lines = String(src)
		.replace(/\uE000/g, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const out = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		const fenceMatch = /^ {0,3}(```|~~~)(\S*)\s*$/.exec(line);
		if (fenceMatch) {
			const fence = fenceMatch[1];
			const lang = fenceMatch[2].replace(/[^a-zA-Z0-9_-]/g, "");
			const fenceCloseRe = new RegExp(`^ {0,3}${fence}\\s*$`);
			const codeLines = [];
			i++;
			while (i < lines.length && !fenceCloseRe.test(lines[i])) {
				codeLines.push(lines[i]);
				i++;
			}
			if (i < lines.length) i++; // consume closing fence
			const langAttr = lang ? ` class="lang-${lang}"` : "";
			out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
			continue;
		}

		if (line.trim() === "") {
			i++;
			continue;
		}

		if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		const headingMatch = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const text = headingMatch[2].replace(/\s+#+\s*$/, "");
			out.push(`<h${level}>${renderInline(text)}</h${level}>`);
			i++;
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const quoteLines = [];
			while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
				quoteLines.push(lines[i].replace(/^ {0,3}> ?/, ""));
				i++;
			}
			out.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"), { streaming })}</blockquote>`);
			continue;
		}

		if (isTableAt(line, lines[i + 1])) {
			const headerCells = splitTableRow(line).map((c) => c.trim());
			const aligns = splitTableRow(lines[i + 1]).map(alignOf);
			i += 2;
			const rows = [];
			while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
				rows.push(splitTableRow(lines[i]).map((c) => c.trim()));
				i++;
			}
			const alignAttr = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
			const thead = `<thead><tr>${headerCells
				.map((c, idx) => `<th${alignAttr(idx)}>${renderInline(c)}</th>`)
				.join("")}</tr></thead>`;
			const tbody = `<tbody>${rows
				.map(
					(r) =>
						`<tr>${r.map((c, idx) => `<td${alignAttr(idx)}>${renderInline(c)}</td>`).join("")}</tr>`,
				)
				.join("")}</tbody>`;
			out.push(`<table>${thead}${tbody}</table>`);
			continue;
		}

		if (/^ {0,3}([-*+]|\d+\.)\s+/.test(line)) {
			const { html, end } = parseList(lines, i, streaming);
			out.push(html);
			i = end;
			continue;
		}

		const paraLines = [line];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) {
			paraLines.push(lines[i]);
			i++;
		}
		out.push(`<p>${renderInline(paraLines.join("\n"))}</p>`);
	}

	return out.join("\n");
}
