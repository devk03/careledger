import type {
  AnchorHTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes,
  SelectHTMLAttributes, TextareaHTMLAttributes, HTMLAttributes, ReactNode,
} from "react";
import { ShieldCheck } from "lucide-react";

type Variant = "primary" | "secondary" | "quiet";
const variants: Record<Variant, string> = {
  primary: "primary-button", secondary: "outline-button", quiet: "quiet-button",
};
const classes = (...values: (string | undefined)[]) => values.filter(Boolean).join(" ");

export function Button({ variant, loading = false, className, disabled, type = "button", ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const resolvedVariant = variant ?? (className ? undefined : "secondary");
  return <button {...props} type={type} disabled={disabled || loading}
    aria-busy={loading || props["aria-busy"] || undefined}
    className={classes("ui-button", resolvedVariant ? variants[resolvedVariant] : undefined, className)} />;
}

export function ButtonLink({ variant = "primary", className, ...props }:
  AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...props} className={classes("ui-button", variants[variant], className)} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={classes("ui-input", className)} />;
}
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={classes("ui-input", className)} />;
}
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={classes("ui-input", className)} />;
}

export function Field({ id, label, hint, error, ...props }:
  InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string; error?: string }) {
  const description = [props["aria-describedby"], `${id}-help`].filter(Boolean).join(" ");
  return <div className="auth-field ui-field">
    <label htmlFor={id}>{label}</label>
    <Input {...props} id={id} aria-describedby={description} aria-invalid={!!error || undefined} />
    <small id={`${id}-help`} className={error ? "ui-field-error" : undefined}>
      {error || hint || <span aria-hidden="true">&nbsp;</span>}
    </small>
  </div>;
}

export function Notice({ tone = "error", className, children, ...props }:
  HTMLAttributes<HTMLParagraphElement> & { tone?: "error" | "info" | "success" }) {
  return <p role={tone === "error" ? "alert" : "status"} aria-live="polite" {...props}
    className={classes("ui-notice", `ui-notice-${tone}`, className)}>{children}</p>;
}

export function Badge({ tone = "neutral", children }:
  { tone?: "neutral" | "review" | "success"; children: ReactNode }) {
  return <span className={`ui-badge ui-badge-${tone}`}>{children}</span>;
}

export function AppHeader({ context = "Private installation", className, children }:
  { context?: ReactNode; className?: string; children?: ReactNode }) {
  return <header className={classes("ui-header", className)}>
    <a className="wordmark" href="/" aria-label="adeno home">adeno</a>
    {children}
    <p><ShieldCheck aria-hidden="true" size={16} />{context}</p>
  </header>;
}
