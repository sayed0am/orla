import Button from "./ui/Button";
import Chip from "./ui/Chip";
import { TextInput } from "./ui/Field";
import GlassCard from "./ui/GlassCard";
import StatTile from "./ui/StatTile";
import TabBar from "./ui/TabBar";

export default function App() {
	return (
		<div className="screen">
			<GlassCard title="Orla">
				<p>A personal assistant that lives at the edge — this is the design system smoke test.</p>
				<div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
					<Button variant="primary">Primary</Button>
					<Button variant="ghost">Ghost</Button>
					<Button variant="danger">Danger</Button>
				</div>
				<div style={{ display: "flex", gap: "var(--s-3)" }}>
					<StatTile label="Notes captured" value="128" tone="lilac" />
					<StatTile label="Actions done" value="42" tone="green" />
				</div>
				<div style={{ display: "flex", gap: "var(--s-2)" }}>
					<Chip tone="lilac">private</Chip>
					<Chip tone="green">synced</Chip>
				</div>
				<TextInput placeholder="Type a note…" />
			</GlassCard>
			<TabBar active="capture" badge={2} />
		</div>
	);
}
