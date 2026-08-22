import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../public/markdown.js";

describe("escapeHtml", () => {
	it("escapes the five reserved characters", () => {
		expect(escapeHtml(`<a href="x">it's & "that"</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;that&quot;&lt;/a&gt;",
		);
	});
});

describe("renderMarkdown: block constructs", () => {
	it("renders ATX headings h1-h6", () => {
		for (let level = 1; level <= 6; level++) {
			const hashes = "#".repeat(level);
			expect(renderMarkdown(`${hashes} Title`)).toBe(`<h${level}>Title</h${level}>`);
		}
	});

	it("strips trailing closing hashes on a heading", () => {
		expect(renderMarkdown("## Title ##")).toBe("<h2>Title</h2>");
	});

	it("renders a paragraph", () => {
		expect(renderMarkdown("Hello world")).toBe("<p>Hello world</p>");
	});

	it("renders a single newline inside a paragraph as a hard break", () => {
		expect(renderMarkdown("line one\nline two")).toBe("<p>line one<br>\nline two</p>");
	});

	it("separates paragraphs on a blank line", () => {
		expect(renderMarkdown("first\n\nsecond")).toBe("<p>first</p>\n<p>second</p>");
	});

	it("renders a fenced code block with a language", () => {
		expect(renderMarkdown("```js\nconst x = 1;\n```")).toBe(
			'<pre><code class="lang-js">const x = 1;</code></pre>',
		);
	});

	it("renders a fenced code block without a language", () => {
		expect(renderMarkdown("```\nplain\n```")).toBe("<pre><code>plain</code></pre>");
	});

	it("escapes HTML inside fenced code blocks and does not parse markdown there", () => {
		expect(renderMarkdown("```\n<b>**not bold**</b>\n```")).toBe(
			"<pre><code>&lt;b&gt;**not bold**&lt;/b&gt;</code></pre>",
		);
	});

	it("supports ~~~ fences", () => {
		expect(renderMarkdown("~~~\ncode\n~~~")).toBe("<pre><code>code</code></pre>");
	});

	it("renders a blockquote", () => {
		expect(renderMarkdown("> quoted line")).toBe("<blockquote><p>quoted line</p></blockquote>");
	});

	it("renders a multi-line blockquote with hard breaks preserved", () => {
		expect(renderMarkdown("> line one\n> line two")).toBe(
			"<blockquote><p>line one<br>\nline two</p></blockquote>",
		);
	});

	it("renders an unordered list", () => {
		expect(renderMarkdown("- a\n- b\n- c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
	});

	it("renders * and + as unordered markers", () => {
		expect(renderMarkdown("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
		expect(renderMarkdown("+ a\n+ b")).toBe("<ul><li>a</li><li>b</li></ul>");
	});

	it("renders an ordered list", () => {
		expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
	});

	it("renders an ordered list with a custom start number", () => {
		expect(renderMarkdown("3. a\n4. b")).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
	});

	it("renders one level of nested list via 2+ space indent", () => {
		expect(renderMarkdown("- a\n  - nested1\n  - nested2\n- b")).toBe(
			"<ul><li>a<ul><li>nested1</li><li>nested2</li></ul></li><li>b</li></ul>",
		);
	});

	it("renders a horizontal rule for ---, ***, and ___", () => {
		expect(renderMarkdown("---")).toBe("<hr>");
		expect(renderMarkdown("***")).toBe("<hr>");
		expect(renderMarkdown("___")).toBe("<hr>");
	});

	it("renders a GFM table with inline-rendered cells", () => {
		const src = "| Name | **Score** |\n| --- | --- |\n| Alice | `10` |";
		expect(renderMarkdown(src)).toBe(
			"<table><thead><tr><th>Name</th><th><strong>Score</strong></th></tr></thead>" +
				"<tbody><tr><td>Alice</td><td><code>10</code></td></tr></tbody></table>",
		);
	});

	it("respects column alignment from the separator row", () => {
		const src = "| L | C | R |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |";
		const html = renderMarkdown(src);
		expect(html).toContain('<th style="text-align:left">L</th>');
		expect(html).toContain('<th style="text-align:center">C</th>');
		expect(html).toContain('<th style="text-align:right">R</th>');
	});

	it("does not treat a pipe-containing line as a table without a valid separator row", () => {
		expect(renderMarkdown("a | b\nnot a separator")).not.toContain("<table>");
	});
});

describe("renderMarkdown: inline constructs", () => {
	it("renders bold", () => {
		expect(renderMarkdown("**bold**")).toBe("<p><strong>bold</strong></p>");
	});

	it("renders italic with * and _", () => {
		expect(renderMarkdown("*italic*")).toBe("<p><em>italic</em></p>");
		expect(renderMarkdown("_italic_")).toBe("<p><em>italic</em></p>");
	});

	it("renders inline code", () => {
		expect(renderMarkdown("`code`")).toBe("<p><code>code</code></p>");
	});

	it("renders strikethrough", () => {
		expect(renderMarkdown("~~gone~~")).toBe("<p><del>gone</del></p>");
	});

	it("renders a safe link with target and rel attributes", () => {
		expect(renderMarkdown("[site](https://example.com)")).toBe(
			'<p><a href="https://example.com" rel="noopener noreferrer" target="_blank">site</a></p>',
		);
	});

	it("renders a mailto link", () => {
		expect(renderMarkdown("[mail](mailto:a@example.com)")).toBe(
			'<p><a href="mailto:a@example.com" rel="noopener noreferrer" target="_blank">mail</a></p>',
		);
	});

	it("autolinks bare http(s) URLs", () => {
		expect(renderMarkdown("see https://example.com/x for more")).toBe(
			'<p>see <a href="https://example.com/x" rel="noopener noreferrer" target="_blank">https://example.com/x</a> for more</p>',
		);
	});

	it("trims trailing sentence punctuation off an autolink", () => {
		expect(renderMarkdown("go to https://example.com, now.")).toBe(
			'<p>go to <a href="https://example.com" rel="noopener noreferrer" target="_blank">https://example.com</a>, now.</p>',
		);
	});
});

describe("renderMarkdown: security", () => {
	it("escapes a script tag instead of injecting it", () => {
		const html = renderMarkdown("<script>alert(1)</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("escapes an img onerror payload", () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)">');
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("does not linkify a javascript: URL", () => {
		const html = renderMarkdown("[x](javascript:alert(1))");
		expect(html).not.toContain("<a ");
		expect(html).not.toContain("javascript:alert(1)</a>");
	});

	it("does not linkify a data: URL", () => {
		const html = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
		expect(html).not.toContain("<a ");
	});

	it("escapes raw HTML found inside table cells", () => {
		const html = renderMarkdown("| a |\n| --- |\n| <img onerror=alert(1)> |");
		expect(html).not.toContain("<img");
	});

	it("escapes raw HTML found inside a blockquote", () => {
		const html = renderMarkdown("> <script>alert(1)</script>");
		expect(html).not.toContain("<script>");
	});
});

describe("renderMarkdown: streaming safety", () => {
	it("renders an unterminated fenced code block as an open block, not leaked paragraphs", () => {
		const html = renderMarkdown("```js\nconst x = 1;\nfunction f() {", { streaming: true });
		expect(html).toBe('<pre><code class="lang-js">const x = 1;\nfunction f() {</code></pre>');
		expect(html).not.toContain("<p>");
	});

	it("renders a dangling ** marker as literal text instead of swallowing the rest", () => {
		const html = renderMarkdown("normal text **then unterminated bold", { streaming: true });
		expect(html).toBe("<p>normal text **then unterminated bold</p>");
	});

	it("renders a dangling ` marker as literal text", () => {
		const html = renderMarkdown("normal `unterminated code", { streaming: true });
		expect(html).toBe("<p>normal `unterminated code</p>");
	});

	it("renders a table with no separator row yet as plain lines", () => {
		const html = renderMarkdown("| Name | Score |", { streaming: true });
		expect(html).not.toContain("<table>");
		expect(html).toBe("<p>| Name | Score |</p>");
	});

	it("renders a trailing partial link as text", () => {
		const html = renderMarkdown("check out [this link](htt", { streaming: true });
		expect(html).toBe("<p>check out [this link](htt</p>");
		expect(html).not.toContain("<a ");
	});

	it("still completes a well-formed bold marker pair while streaming", () => {
		expect(renderMarkdown("**done**", { streaming: true })).toBe("<p><strong>done</strong></p>");
	});
});

describe("renderMarkdown: idempotence between streaming and final render", () => {
	const samples = [
		"# Title\n\nSome **bold** and *italic* text with `code`.",
		"- one\n- two\n  - nested\n- three",
		"1. first\n2. second",
		"> a quote\n> spanning lines",
		"| a | b |\n| --- | --- |\n| 1 | 2 |",
		"```ts\nconst x: number = 1;\n```",
		"line one\nline two\n\nnew paragraph with [a link](https://example.com).",
	];

	for (const sample of samples) {
		it(`matches for: ${JSON.stringify(sample).slice(0, 40)}...`, () => {
			expect(renderMarkdown(sample, { streaming: true })).toBe(renderMarkdown(sample));
		});
	}

	it("matches after simulating character-by-character streaming", () => {
		const full =
			"Here's the plan:\n\n1. First step\n2. Second step\n\n" +
			"```js\nfunction hi() {\n  return 1;\n}\n```\n\n" +
			"See https://example.com for details.";
		let acc = "";
		let last = "";
		for (const ch of full) {
			acc += ch;
			last = renderMarkdown(acc, { streaming: true });
		}
		expect(last).toBe(renderMarkdown(full));
	});
});

describe("renderMarkdown: realistic assistant reply", () => {
	it("renders a multi-paragraph reply with a list and a code block", () => {
		const reply = [
			"Here's how to set that up:",
			"",
			"1. Install the dependency",
			"2. Add the config",
			"",
			"```bash",
			"npm install orla",
			"```",
			"",
			"Let me know if you hit any issues!",
		].join("\n");

		const html = renderMarkdown(reply);
		expect(html).toContain("<p>Here&#39;s how to set that up:</p>");
		expect(html).toContain("<ol><li>Install the dependency</li><li>Add the config</li></ol>");
		expect(html).toContain('<pre><code class="lang-bash">npm install orla</code></pre>');
		expect(html).toContain("<p>Let me know if you hit any issues!</p>");
	});
});
