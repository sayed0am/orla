import type { ButtonHTMLAttributes } from "react";

interface FabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	"aria-label": string;
}

export default function Fab({ className, ...rest }: FabProps) {
	const classes = ["fab", className].filter(Boolean).join(" ");
	return <button type="button" className={classes} {...rest} />;
}
