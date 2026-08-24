import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
	width: 24,
	height: 24,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": true,
	focusable: false,
};

export function IconCapture(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Capture</title>
			<rect x="3" y="3" width="18" height="18" rx="5" />
			<path d="M12 8v8M8 12h8" />
		</svg>
	);
}

export function IconChat(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Chat</title>
			<path d="M4 5h16v11H8l-4 4V5z" />
		</svg>
	);
}

export function IconBrief(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Brief</title>
			<path d="M3 17a9 9 0 0 1 18 0" />
			<path d="M12 3v4M4.2 8.2l2.1 2.1M19.8 8.2l-2.1 2.1" />
			<path d="M3 20h18" />
		</svg>
	);
}

export function IconJournal(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Journal</title>
			<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4z" />
			<path d="M5 18a2 2 0 0 1 2-2h11" />
		</svg>
	);
}

export function IconSettings(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Settings</title>
			<circle cx="12" cy="12" r="3" />
			<path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.3.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.5a7 7 0 0 0-2.1 1.2l-2.3-.9-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-.9c.6.5 1.3.9 2.1 1.2L10 21h4l.5-2.5a7 7 0 0 0 2.1-1.2l2.3.9 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z" />
		</svg>
	);
}

export function IconSend(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Send</title>
			<path d="M12 19V5M6 11l6-6 6 6" />
		</svg>
	);
}

export function IconClose(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Close</title>
			<path d="M6 6l12 12M18 6L6 18" />
		</svg>
	);
}

export function IconChevronLeft(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Previous</title>
			<path d="M15 6l-6 6 6 6" />
		</svg>
	);
}

export function IconChevronRight(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...base} {...props}>
			<title>Next</title>
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}
