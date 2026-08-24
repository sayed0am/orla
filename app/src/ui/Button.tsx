import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "primary" | "ghost" | "danger";
}

export default function Button({ variant = "ghost", className, ...rest }: ButtonProps) {
	const classes = ["btn", `btn-${variant}`, className].filter(Boolean).join(" ");
	return <button type="button" className={classes} {...rest} />;
}
