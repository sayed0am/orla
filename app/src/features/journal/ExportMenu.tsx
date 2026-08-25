/** Journal header export control: an icon button that opens a small dropdown offering the JSON
 * and Markdown export links. Closes on an outside click/tap or Escape. */

import { useEffect, useRef, useState } from "react";
import { IconFileExport, IconJson, IconMarkdown } from "../../ui/icons";

export default function ExportMenu() {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}

		function onPointerDown(event: PointerEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setOpen(false);
			}
		}

		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div className="export-menu" ref={rootRef}>
			<button
				type="button"
				className="icon-btn"
				aria-label="Export journal"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<IconFileExport width={16} height={16} />
			</button>
			{open ? (
				<div className="glass export-menu-pop" role="menu">
					<a
						className="export-menu-item"
						role="menuitem"
						href="/api/export?format=markdown"
						onClick={() => setOpen(false)}
					>
						<IconMarkdown width={18} height={18} />
						Markdown
					</a>
					<a
						className="export-menu-item"
						role="menuitem"
						href="/api/export"
						onClick={() => setOpen(false)}
					>
						<IconJson width={18} height={18} />
						JSON
					</a>
				</div>
			) : null}
		</div>
	);
}
