interface SegmentedTabsOption {
	value: string;
	label: string;
}

interface SegmentedTabsProps {
	options: SegmentedTabsOption[];
	value: string;
	onChange: (value: string) => void;
}

export default function SegmentedTabs({ options, value, onChange }: SegmentedTabsProps) {
	return (
		<div className="seg" role="tablist">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="tab"
					aria-selected={option.value === value}
					className={["seg-item", option.value === value ? "active" : null]
						.filter(Boolean)
						.join(" ")}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
