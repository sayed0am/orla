import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className, ...rest }: TextInputProps) {
	const classes = ["field", className].filter(Boolean).join(" ");
	return <input className={classes} {...rest} />;
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea({ className, ...rest }: TextAreaProps) {
	const classes = ["field", className].filter(Boolean).join(" ");
	return <textarea className={classes} {...rest} />;
}
