/** `event: tool` from the stream (PRD §12): a small chip inline in the transcript. */

import type { ToolItem } from "../../hooks/useChatStream";
import Chip from "../../ui/Chip";

interface ToolChipProps {
	item: ToolItem;
}

export default function ToolChip({ item }: ToolChipProps) {
	const label = `🔧 ${item.name} · ${item.status === "error" ? "error" : "done"}`;
	return (
		<Chip tone={item.status === "error" ? "danger" : "green"}>
			<span title={item.preview}>{label}</span>
		</Chip>
	);
}
