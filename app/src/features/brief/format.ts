/** Date helpers for the Brief tab (port of public/brief.js's date/time helpers). */

export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

export function shiftDate(dateStr: string, deltaDays: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + deltaDays);
	return d.toISOString().slice(0, 10);
}

export function formatDateLabel(dateStr: string): string {
	try {
		return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		});
	} catch {
		return dateStr;
	}
}

export function formatDueDate(dueDate: string | null | undefined): string {
	if (!dueDate) {
		return "";
	}
	try {
		return new Date(`${dueDate}T00:00:00Z`).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		});
	} catch {
		return dueDate;
	}
}

export function isOverdue(dueDate: string | null | undefined): boolean {
	if (!dueDate) {
		return false;
	}
	return dueDate < todayUtc();
}
