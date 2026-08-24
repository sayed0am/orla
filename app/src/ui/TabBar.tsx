import Badge from "./Badge";
import { IconBrief, IconCapture, IconChat, IconJournal, IconSettings } from "./icons";

interface TabBarProps {
	active: string;
	badge?: number;
}

const TABS = [
	{ value: "capture", label: "Capture", Icon: IconCapture },
	{ value: "chat", label: "Chat", Icon: IconChat },
	{ value: "brief", label: "Brief", Icon: IconBrief },
	{ value: "journal", label: "Journal", Icon: IconJournal },
	{ value: "settings", label: "Settings", Icon: IconSettings },
];

export default function TabBar({ active, badge = 0 }: TabBarProps) {
	return (
		<nav className="tabbar glass" aria-label="Orla sections">
			{TABS.map(({ value, label, Icon }) => {
				const isActive = value === active;
				const classes = ["tabbar-item", isActive ? "active" : null].filter(Boolean).join(" ");
				return (
					<a
						key={value}
						href={`#${value}`}
						className={classes}
						aria-current={isActive ? "page" : undefined}
					>
						<Icon width={22} height={22} />
						<span>{label}</span>
						{value === "chat" && badge > 0 ? (
							<span className="tabbar-badge">
								<Badge count={badge} />
							</span>
						) : null}
					</a>
				);
			})}
		</nav>
	);
}
