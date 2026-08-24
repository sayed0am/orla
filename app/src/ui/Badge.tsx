interface BadgeProps {
	count: number;
}

export default function Badge({ count }: BadgeProps) {
	if (count <= 0) return null;
	return <span className="badge">{count}</span>;
}
