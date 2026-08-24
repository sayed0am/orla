/** MCP servers section (PRD §12): connect/manage third-party MCP servers. Port of brief.js's MCP
 * servers section. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import GlassCard from "../../ui/GlassCard";
import { formatDateTime } from "./format";

interface McpServer {
	id: string;
	name: string;
	enabled: boolean;
	tool_count: number;
	tiers: { read: number; act: number };
	schema_refreshed_at: string | null;
}

function McpServerRow({
	server,
	onToggle,
	onTest,
	onRefresh,
	onRemove,
}: {
	server: McpServer;
	onToggle: (server: McpServer, next: boolean) => Promise<void>;
	onTest: (server: McpServer) => Promise<void>;
	onRefresh: (server: McpServer) => Promise<void>;
	onRemove: (server: McpServer) => Promise<boolean>;
}) {
	const [checked, setChecked] = useState(server.enabled);
	const [toggleBusy, setToggleBusy] = useState(false);
	const [testBusy, setTestBusy] = useState(false);
	const [refreshBusy, setRefreshBusy] = useState(false);
	const [removeBusy, setRemoveBusy] = useState(false);

	useEffect(() => {
		setChecked(server.enabled);
	}, [server.enabled]);

	async function handleToggle() {
		const next = !checked;
		setChecked(next);
		setToggleBusy(true);
		try {
			await onToggle(server, next);
		} catch {
			setChecked(!next);
		} finally {
			setToggleBusy(false);
		}
	}

	async function handleTest() {
		setTestBusy(true);
		await onTest(server);
		setTestBusy(false);
	}

	async function handleRefresh() {
		setRefreshBusy(true);
		await onRefresh(server);
		setRefreshBusy(false);
	}

	async function handleRemove() {
		setRemoveBusy(true);
		const ok = await onRemove(server);
		if (!ok) {
			setRemoveBusy(false);
		}
	}

	const toolWord = server.tool_count === 1 ? "tool" : "tools";

	return (
		<div className="mcp-server-row">
			<div className="mcp-server-info">
				<label className="mcp-server-name">
					<input type="checkbox" checked={checked} disabled={toggleBusy} onChange={handleToggle} />
					{server.name}
				</label>
				<p className="mcp-server-meta hint">
					{server.tool_count} {toolWord} ({server.tiers.read} read, {server.tiers.act} act) · Schema
					refreshed {formatDateTime(server.schema_refreshed_at)}
				</p>
			</div>
			<div className="mcp-server-actions">
				<Button disabled={testBusy} onClick={handleTest}>
					{testBusy ? "Testing…" : "Test"}
				</Button>
				<Button disabled={refreshBusy} onClick={handleRefresh}>
					{refreshBusy ? "Refreshing…" : "Refresh schema"}
				</Button>
				<Button disabled={removeBusy} onClick={handleRemove}>
					Remove
				</Button>
			</div>
		</div>
	);
}

function McpAddForm({
	onSubmit,
}: {
	onSubmit: (name: string, url: string, authHeader: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [authHeader, setAuthHeader] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit() {
		const n = name.trim();
		const u = url.trim();
		if (n.length === 0 || u.length === 0) {
			return;
		}
		setBusy(true);
		const ok = await onSubmit(n, u, authHeader.trim());
		if (ok) {
			setName("");
			setUrl("");
			setAuthHeader("");
		}
		setBusy(false);
	}

	return (
		<div className="mcp-add-row">
			<TextInput
				type="text"
				placeholder="Name (e.g. Calendar)"
				maxLength={60}
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<TextInput
				type="text"
				placeholder="https://your-mcp-server.example.com/mcp"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
			/>
			<TextInput
				type="text"
				placeholder="Authorization header value (optional, e.g. Bearer …)"
				value={authHeader}
				onChange={(e) => setAuthHeader(e.target.value)}
			/>
			<p className="mcp-disclosure hint">
				ZDR covers inference routing only; each MCP server processes data under its own policy.
			</p>
			<Button variant="primary" disabled={busy} onClick={submit}>
				Add server
			</Button>
		</div>
	);
}

export default function McpServers() {
	const [servers, setServers] = useState<McpServer[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
	const destroyedRef = useRef(false);

	const load = useCallback(async () => {
		setLoadError(false);
		let res: Response;
		try {
			res = await apiFetch("/api/mcp/servers");
		} catch (err) {
			console.error("settings: failed to load MCP servers", err);
			if (!destroyedRef.current) {
				setServers(null);
				setLoadError(true);
			}
			return;
		}
		if (destroyedRef.current) {
			return;
		}
		if (!res.ok) {
			setServers(null);
			setLoadError(true);
			return;
		}
		const data = (await res.json()) as { servers?: McpServer[] };
		setServers(data.servers ?? []);
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		load();
		return () => {
			destroyedRef.current = true;
		};
	}, [load]);

	function showMessage(text: string, ok = false) {
		setMessage({ text, ok });
	}

	async function toggleEnabled(server: McpServer, next: boolean) {
		try {
			const res = await apiFetch(`/api/mcp/servers/${server.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: next }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			await load();
		} catch (err) {
			console.error("settings: failed to toggle MCP server", err);
			showMessage("Couldn't update that server.");
			throw err;
		}
	}

	async function testServer(server: McpServer) {
		try {
			const res = await apiFetch(`/api/mcp/servers/${server.id}/test`, { method: "POST" });
			const body = (await res.json()) as { ok?: boolean; error?: string; tools?: unknown[] };
			if (!res.ok || !body.ok) {
				showMessage(body.error || "Couldn't reach that server.");
			} else {
				showMessage(`Connected — ${(body.tools ?? []).length} tool(s) found.`, true);
			}
		} catch (err) {
			console.error("settings: failed to test MCP server", err);
			showMessage("Couldn't reach that server.");
		}
	}

	async function refreshServer(server: McpServer) {
		try {
			const res = await apiFetch(`/api/mcp/servers/${server.id}/refresh`, { method: "POST" });
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			await load();
		} catch (err) {
			console.error("settings: failed to refresh MCP server", err);
			showMessage("Couldn't refresh that server's tools.");
		}
	}

	async function removeServer(server: McpServer): Promise<boolean> {
		try {
			const res = await apiFetch(`/api/mcp/servers/${server.id}`, { method: "DELETE" });
			if (!res.ok && res.status !== 204) {
				throw new Error(`http ${res.status}`);
			}
			await load();
			return true;
		} catch (err) {
			console.error("settings: failed to remove MCP server", err);
			showMessage("Couldn't remove that server.");
			return false;
		}
	}

	async function addServer(name: string, url: string, authHeader: string): Promise<boolean> {
		setMessage(null);
		try {
			const res = await apiFetch("/api/mcp/servers", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name, url, auth_header: authHeader || undefined }),
			});
			const body = (await res.json()) as { error?: string };
			if (!res.ok) {
				throw new Error(body.error || `http ${res.status}`);
			}
			await load();
			return true;
		} catch (err) {
			console.error("settings: failed to add MCP server", err);
			showMessage(err instanceof Error ? err.message : "Couldn't add that server.");
			return false;
		}
	}

	return (
		<GlassCard title="MCP servers">
			{servers === null && !loadError ? <p className="hint">Loading…</p> : null}
			{loadError ? <p className="hint">Couldn't load MCP servers.</p> : null}
			{servers !== null ? (
				<>
					{servers.length === 0 ? (
						<p className="hint">No MCP servers connected.</p>
					) : (
						servers.map((server) => (
							<McpServerRow
								key={server.id}
								server={server}
								onToggle={toggleEnabled}
								onTest={testServer}
								onRefresh={refreshServer}
								onRemove={removeServer}
							/>
						))
					)}
					<McpAddForm onSubmit={addServer} />
					{message ? (
						<p className={message.ok ? "hint" : "mcp-error hint"}>{message.text}</p>
					) : null}
				</>
			) : null}
		</GlassCard>
	);
}
