/** Chat tab: conversation list + streaming message view (PRD F1). */

import { apiFetch } from "./api.js";
import { renderMarkdown } from "./markdown.js";

/**
 * Parses one SSE event block (lines already split, blank-line separated) into
 * `{ event, data }`. `event` defaults to "message" per the SSE spec.
 */
function parseEventBlock(block) {
	let event = "message";
	const dataLines = [];
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
 * Reads an SSE `Response` body, invoking `onEvent({event, data})` for each event.
 * @param {Response} res
 * @param {(evt: {event: string, data: string}) => void} onEvent
 */
async function readSse(res, onEvent) {
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
				onEvent(parseEventBlock(block));
			}
			sepIndex = buffer.indexOf("\n\n");
		}
	}
}

function formatTimestamp(iso) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

export function mountChat(root) {
	const view = document.createElement("div");
	view.className = "chat-view";
	view.innerHTML = `
		<div class="conversation-list" id="conversation-list">
			<button type="button" class="primary" id="chat-new" style="width:100%;margin-bottom:0.5rem;">New</button>
			<div id="conversation-items"></div>
		</div>
		<div class="chat-main hidden" id="chat-main">
			<div class="composer" style="border-top:none;border-bottom:1px solid var(--border);">
				<button type="button" id="chat-back">&larr; Conversations</button>
			</div>
			<div class="messages" id="chat-messages"></div>
			<div class="composer">
				<textarea id="chat-input" placeholder="Message Orla…" rows="1"></textarea>
				<button type="button" class="primary" id="chat-send">Send</button>
			</div>
		</div>
	`;
	root.appendChild(view);

	const listEl = view.querySelector("#conversation-list");
	const itemsEl = view.querySelector("#conversation-items");
	const mainEl = view.querySelector("#chat-main");
	const messagesEl = view.querySelector("#chat-messages");
	const inputEl = view.querySelector("#chat-input");
	const sendButton = view.querySelector("#chat-send");
	const newButton = view.querySelector("#chat-new");
	const backButton = view.querySelector("#chat-back");

	let destroyed = false;
	let activeConversationId;
	let userScrolledUp = false;
	let sending = false;

	function showUnavailable(message) {
		itemsEl.innerHTML = "";
		const p = document.createElement("p");
		p.className = "hint";
		p.style.padding = "0.75rem";
		p.textContent = message;
		itemsEl.appendChild(p);
		newButton.disabled = true;
	}

	function showMobileConversation(show) {
		if (show) {
			listEl.classList.add("hidden");
			mainEl.classList.remove("hidden");
		} else {
			listEl.classList.remove("hidden");
			mainEl.classList.add("hidden");
		}
	}

	async function loadConversations() {
		let res;
		try {
			res = await apiFetch("/api/conversations");
		} catch (err) {
			console.error("chat: failed to load conversations", err);
			showUnavailable("Chat is unavailable right now.");
			return;
		}
		if (destroyed) {
			return;
		}
		if (res.status === 404) {
			showUnavailable("Chat isn't set up yet.");
			return;
		}
		if (!res.ok) {
			showUnavailable("Chat is unavailable right now.");
			return;
		}

		const data = await res.json();
		const conversations = data.conversations ?? [];
		itemsEl.innerHTML = "";
		if (conversations.length === 0) {
			const p = document.createElement("p");
			p.className = "hint";
			p.style.padding = "0.75rem";
			p.textContent = "No conversations yet.";
			itemsEl.appendChild(p);
			return;
		}
		for (const conversation of conversations) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "conversation-item";
			button.title = formatTimestamp(conversation.updated_at ?? conversation.created_at);
			button.textContent = conversation.title || "Untitled";
			button.addEventListener("click", () => openConversation(conversation.id));
			itemsEl.appendChild(button);
		}
	}

	async function openConversation(id) {
		activeConversationId = id;
		showMobileConversation(true);
		messagesEl.innerHTML = "";
		userScrolledUp = false;

		let res;
		try {
			res = await apiFetch(`/api/conversations/${id}/messages`);
		} catch (err) {
			console.error("chat: failed to load messages", err);
			appendErrorBubble("Couldn't load this conversation.");
			return;
		}
		if (!res.ok) {
			appendErrorBubble("Couldn't load this conversation.");
			return;
		}
		const data = await res.json();
		for (const turn of data.turns ?? []) {
			appendBubble(turn.role, turn.content);
		}
		scrollToBottom(true);
	}

	async function createConversation() {
		let res;
		try {
			res = await apiFetch("/api/conversations", { method: "POST" });
		} catch (err) {
			console.error("chat: failed to create conversation", err);
			return;
		}
		if (!res.ok) {
			return;
		}
		const conversation = await res.json();
		await loadConversations();
		openConversation(conversation.id);
	}

	function renderAssistantContent(bubble, text, streaming) {
		let content = bubble.querySelector(".md");
		if (!content) {
			content = document.createElement("div");
			content.className = "md";
			bubble.appendChild(content);
		}
		content.innerHTML = renderMarkdown(text, { streaming });
	}

	function appendBubble(role, text) {
		const bubble = document.createElement("div");
		bubble.className = `bubble ${role}`;
		if (role === "assistant") {
			renderAssistantContent(bubble, text, false);
		} else {
			bubble.textContent = text;
		}
		messagesEl.appendChild(bubble);
		if (!userScrolledUp) {
			scrollToBottom();
		}
		return bubble;
	}

	function appendErrorBubble(text) {
		const bubble = document.createElement("div");
		bubble.className = "bubble error";
		bubble.textContent = text;
		messagesEl.appendChild(bubble);
		scrollToBottom();
	}

	function scrollToBottom(force) {
		if (force || !userScrolledUp) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	messagesEl.addEventListener("scroll", () => {
		const distanceFromBottom =
			messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
		userScrolledUp = distanceFromBottom > 40;
	});

	async function send() {
		const text = inputEl.value.trim();
		if (text.length === 0 || sending || !activeConversationId) {
			return;
		}

		sending = true;
		sendButton.disabled = true;
		inputEl.value = "";
		appendBubble("user", text);
		const assistantBubble = appendBubble("assistant", "");

		try {
			const res = await apiFetch(`/api/conversations/${activeConversationId}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: text }),
			});

			if (res.status === 409) {
				assistantBubble.remove();
				appendErrorBubble("Orla is still replying to a previous message.");
				return;
			}
			if (!res.ok || !res.body) {
				assistantBubble.remove();
				appendErrorBubble("Something went wrong sending that message.");
				return;
			}

			let assistantText = "";
			let streamError;
			let rafHandle = null;

			const scheduleAssistantRender = () => {
				if (rafHandle !== null) {
					return;
				}
				rafHandle = requestAnimationFrame(() => {
					rafHandle = null;
					renderAssistantContent(assistantBubble, assistantText, true);
					if (!userScrolledUp) {
						scrollToBottom();
					}
				});
			};

			await readSse(res, (evt) => {
				if (evt.event === "delta") {
					let delta;
					try {
						delta = JSON.parse(evt.data);
					} catch {
						delta = evt.data;
					}
					assistantText += typeof delta === "string" ? delta : (delta.text ?? "");
					scheduleAssistantRender();
				} else if (evt.event === "error") {
					try {
						streamError = JSON.parse(evt.data).message;
					} catch {
						streamError = "stream error";
					}
				}
			});

			// Coalesced rAF renders may be mid-flight or skipped for the last delta(s); the
			// final, non-streaming render always happens so the bubble ends up fully parsed.
			if (rafHandle !== null) {
				cancelAnimationFrame(rafHandle);
				rafHandle = null;
			}
			renderAssistantContent(assistantBubble, assistantText, false);
			if (!userScrolledUp) {
				scrollToBottom();
			}

			if (streamError) {
				appendErrorBubble(streamError);
			}
		} catch (err) {
			console.error("chat: send failed", err);
			appendErrorBubble("Something went wrong sending that message.");
		} finally {
			sending = false;
			sendButton.disabled = false;
		}
	}

	newButton.addEventListener("click", createConversation);
	backButton.addEventListener("click", () => showMobileConversation(false));
	sendButton.addEventListener("click", send);
	inputEl.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			send();
		}
	});

	loadConversations();

	return function unmount() {
		destroyed = true;
	};
}
