"use client";

import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { cn } from "./cn";

/**
 * Button variants mirror the dashboard's DesignButton (`default`/`outline`/`ghost`/`destructive`),
 * scaled down to the two sizes this tool needs.
 */
export type ButtonVariant = "default" | "outline" | "ghost" | "destructive";

const buttonVariantClasses = new Map<ButtonVariant, string>([
  ["default", "bg-primary text-primary-foreground hover:bg-primary/90"],
  ["outline", "border border-black/[0.08] dark:border-white/[0.08] bg-card text-foreground hover:bg-foreground/[0.06]"],
  ["ghost", "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"],
  ["destructive", "bg-destructive text-destructive-foreground hover:bg-destructive/90"],
]);

export type ButtonSize = "xs" | "sm" | "md";

const buttonSizeClasses = new Map<ButtonSize, string>([
  ["xs", "h-6 rounded-md px-2 text-[11px]"],
  ["sm", "h-7 rounded-md px-2.5 text-xs"],
  ["md", "h-9 rounded-lg px-4 text-sm"],
]);

export function Button({
  children,
  variant = "outline",
  size = "sm",
  className,
  ...props
}: {
  variant?: ButtonVariant,
  size?: ButtonSize,
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium",
        "transition-colors hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-60",
        buttonSizeClasses.get(size) ?? throwErr(`No button classes for size ${size}; buttonSizeClasses must cover every ButtonSize`),
        buttonVariantClasses.get(variant) ?? throwErr(`No button classes for variant ${variant}; buttonVariantClasses must cover every ButtonVariant`),
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Filter chip. `active` is the selected state of a segmented control or multi-select filter row. */
export function Pill({
  children,
  active,
  mono = false,
  className,
  ...props
}: {
  active: boolean,
  mono?: boolean,
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight",
        "transition-colors hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        mono && "font-mono",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-foreground/[0.06] text-muted-foreground ring-1 ring-foreground/[0.06] hover:bg-foreground/[0.1] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

const fieldClasses = cn(
  "w-full rounded-lg border border-black/[0.08] bg-card text-foreground shadow-sm ring-1 ring-black/[0.04]",
  "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "transition-colors hover:transition-none",
  "dark:border-white/[0.08] dark:ring-white/[0.04]",
);

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldClasses, "h-7 px-2 text-xs", className)} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldClasses, "px-2 py-1.5 text-xs", className)} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(fieldClasses, "h-7 px-2 text-xs", className)}>
      {children}
    </select>
  );
}

/** Uppercase micro-label used to the left of filter groups and above form fields. */
export function FieldLabel({ children, className }: { children: React.ReactNode, className?: string }) {
  return (
    <span className={cn("text-[10px] font-medium uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/** Vertical hairline separating filter groups in a toolbar. */
export function Divider({ className }: { className?: string }) {
  return <span className={cn("mx-1.5 h-4 w-px bg-border", className)} />;
}
