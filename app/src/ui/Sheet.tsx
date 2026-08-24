import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

interface SheetProps {
	open: boolean;
	onClose: () => void;
	children?: ReactNode;
}

export default function Sheet({ open, onClose, children }: SheetProps) {
	if (!open) return null;

	function stop(event: MouseEvent<HTMLDivElement>) {
		event.stopPropagation();
	}

	function stopKey(event: KeyboardEvent<HTMLDivElement>) {
		event.stopPropagation();
	}

	function onOverlayKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
		if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
			onClose();
		}
	}

	return (
		<div className="sheet-overlay">
			<button
				type="button"
				className="sheet-overlay-dismiss"
				aria-label="Close"
				onClick={onClose}
				onKeyDown={onOverlayKeyDown}
			/>
			<div className="sheet" role="dialog" aria-modal="true" onClick={stop} onKeyDown={stopKey}>
				{children}
			</div>
		</div>
	);
}
