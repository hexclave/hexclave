"use client";

import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { forwardRef, useState, type ReactNode } from "react";
import { cn } from "../../components/design/cn";
import { Icon, type IconName } from "./icons";

/*
 * Console design primitives.
 *
 * Conventions shared by every component in this file:
 * - Visual variants are props, never caller classNames: `cn` is plain clsx (no tailwind-merge), so
 *   a caller's `px-4` would compete with a default `px-3` instead of replacing it. `className` is
 *   for layout only (margins, flex/grid placement, widths).
 * - Hover styles change instantly and fade out on leave (`transition-colors hover:transition-none`),
 *   per the repo's motion rule.
 */

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

// ─── Button ──────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "xs" | "sm" | "md";

const buttonVariants = new Map<ButtonVariant, string>([
  ["primary", "bg-primary text-primary-foreground shadow-sm hover:bg-primary/85"],
  ["secondary", "border border-border bg-card text-foreground shadow-sm hover:bg-muted"],
  ["ghost", "text-muted-foreground hover:bg-muted hover:text-foreground"],
  ["danger", "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"],
  ["danger-ghost", "text-red-600 hover:bg-red-500/10 dark:text-red-400"],
]);

const buttonSizes = new Map<ButtonSize, string>([
  ["xs", "h-6 gap-1 rounded-md px-2 text-[11px]"],
  ["sm", "h-7 gap-1.5 rounded-md px-2.5 text-xs"],
  ["md", "h-8 gap-2 rounded-lg px-3 text-[13px]"],
]);

// Icon-only buttons get their own size map instead of a `px-0` override (see the note on `cn` above).
const squareButtonSizes = new Map<ButtonSize, string>([
  ["xs", "size-6 rounded-md"],
  ["sm", "size-7 rounded-md"],
  ["md", "size-8 rounded-lg"],
]);

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  variant?: ButtonVariant,
  size?: ButtonSize,
  icon?: IconName,
  trailingIcon?: IconName,
  /** Shortcut hint rendered as a <Kbd> at the end of the label. */
  shortcut?: string,
  /** Forces the loading state (eg. while a parent-owned request is in flight). */
  loading?: boolean,
  /** Square, icon-only sizing. Prefer `IconButton`, which also requires an accessible label. */
  square?: boolean,
  /**
   * May return a promise: the button then shows its loading state until it settles, and a
   * rejection surfaces through `runAsynchronouslyWithAlert` instead of being swallowed.
   */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary",
  size = "sm",
  icon,
  trailingIcon,
  shortcut,
  loading: loadingProp = false,
  square = false,
  onClick,
  disabled,
  className,
  children,
  type = "button",
  ...props
}, ref) {
  const [pending, setPending] = useState(false);
  const loading = loadingProp || pending;
  return (
    <button
      ref={ref}
      type={type}
      {...props}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      onClick={event => {
        const result = onClick?.(event);
        if (result instanceof Promise) {
          setPending(true);
          runAsynchronouslyWithAlert(result.finally(() => setPending(false)));
        }
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium",
        "transition-colors hover:transition-none disabled:pointer-events-none disabled:opacity-50",
        focusRing,
        (square ? squareButtonSizes : buttonSizes).get(size) ?? throwErr(`No button size classes for ${size}`),
        buttonVariants.get(variant) ?? throwErr(`No button variant classes for ${variant}`),
        className,
      )}
    >
      {loading ? <Spinner size={size === "md" ? "md" : "sm"} /> : icon != null && <Icon name={icon} size={size === "md" ? "md" : "sm"} />}
      {children}
      {trailingIcon != null && <Icon name={trailingIcon} size="sm" />}
      {shortcut != null && <Kbd className="ml-1">{shortcut}</Kbd>}
    </button>
  );
});

/** Square icon-only button. `label` is required because there is no visible text. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "children" | "icon" | "trailingIcon" | "shortcut" | "square"> & { icon: IconName, label: string }>(
  function IconButton({ icon, label, size = "sm", variant = "ghost", ...props }, ref) {
    return (
      <Button
        ref={ref}
        {...props}
        square
        size={size}
        variant={variant}
        aria-label={label}
        title={props.title ?? label}
        icon={icon}
      />
    );
  },
);

// ─── Small atoms ─────────────────────────────────────────────────────

export function Spinner({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70",
        size === "sm" ? "size-3" : "size-3.5",
      )}
    />
  );
}

export function Kbd({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <kbd className={cn(
      "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[10px] font-medium leading-none text-muted-foreground",
      className,
    )}>
      {children}
    </kbd>
  );
}

export type Tone = "neutral" | "blue" | "violet" | "green" | "amber" | "red" | "cyan";

const toneBadgeClasses = new Map<Tone, string>([
  ["neutral", "bg-muted text-muted-foreground ring-border"],
  ["blue", "bg-blue-500/10 text-blue-700 ring-blue-500/20 dark:text-blue-300"],
  ["violet", "bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:text-violet-300"],
  ["green", "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300"],
  ["amber", "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300"],
  ["red", "bg-red-500/10 text-red-700 ring-red-500/20 dark:text-red-300"],
  ["cyan", "bg-cyan-500/10 text-cyan-700 ring-cyan-500/20 dark:text-cyan-300"],
]);

const toneDotClasses = new Map<Tone, string>([
  ["neutral", "bg-muted-foreground/60"],
  ["blue", "bg-blue-500"],
  ["violet", "bg-violet-500"],
  ["green", "bg-emerald-500"],
  ["amber", "bg-amber-500"],
  ["red", "bg-red-500"],
  ["cyan", "bg-cyan-500"],
]);

export function toneDotClass(tone: Tone): string {
  return toneDotClasses.get(tone) ?? throwErr(`No dot classes for tone ${tone}`);
}

export function Badge({ children, tone = "neutral", mono = false, dot = false, title, className }: {
  children: ReactNode,
  tone?: Tone,
  mono?: boolean,
  /** Leading status dot in the badge's tone. */
  dot?: boolean,
  title?: string,
  className?: string,
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded-md px-1.5 font-medium ring-1 ring-inset",
        mono ? "font-mono text-[10.5px]" : "text-[11px]",
        toneBadgeClasses.get(tone) ?? throwErr(`No badge classes for tone ${tone}`),
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 shrink-0 rounded-full", toneDotClass(tone))} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Small round status indicator; `pulse` adds a halo for "live" states. */
export function StatusDot({ tone, pulse = false, className }: { tone: Tone, pulse?: boolean, className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-50", toneDotClass(tone))} />}
      <span className={cn("relative inline-flex size-2 rounded-full", toneDotClass(tone))} />
    </span>
  );
}

// ─── Surfaces ────────────────────────────────────────────────────────

export function Card({ children, className, as: Component = "section", ...props }: {
  children: ReactNode,
  className?: string,
  as?: "section" | "div" | "article",
} & Omit<React.HTMLAttributes<HTMLElement>, "className" | "children">) {
  return (
    <Component {...props} className={cn("overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]", className)}>
      {children}
    </Component>
  );
}

export function CardHeader({ title, description, actions, className }: {
  title: ReactNode,
  description?: ReactNode,
  actions?: ReactNode,
  className?: string,
}) {
  return (
    <header className={cn("flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2.5", className)}>
      <div className="min-w-0">
        <h3 className="truncate text-[13px] font-semibold tracking-tight text-foreground">{title}</h3>
        {description != null && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions != null && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

export function CardBody({ children, className, padded = true }: { children: ReactNode, className?: string, padded?: boolean }) {
  return <div className={cn(padded && "p-4", className)}>{children}</div>;
}

export type CalloutTone = "error" | "warning" | "info" | "success";

const calloutClasses = new Map<CalloutTone, { box: string, icon: IconName }>([
  ["error", { box: "border-red-500/25 bg-red-500/[0.06] text-red-800 dark:text-red-200", icon: "alert" }],
  ["warning", { box: "border-amber-500/30 bg-amber-500/[0.07] text-amber-900 dark:text-amber-200", icon: "alert" }],
  ["info", { box: "border-blue-500/25 bg-blue-500/[0.06] text-blue-900 dark:text-blue-200", icon: "clock" }],
  ["success", { box: "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-900 dark:text-emerald-200", icon: "check" }],
]);

/**
 * Inline status panel for blocking errors and notices. The repo convention is alerts, not toasts,
 * for anything the user must not miss, so every failed load or mutation in the console lands here.
 */
export function Callout({ tone = "error", title, children, actions, className }: {
  tone?: CalloutTone,
  title?: ReactNode,
  children?: ReactNode,
  actions?: ReactNode,
  className?: string,
}) {
  const classes = calloutClasses.get(tone) ?? throwErr(`No callout classes for tone ${tone}`);
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs", classes.box, className)}>
      <Icon name={classes.icon} className="mt-px opacity-80" />
      <div className="min-w-0 flex-1 space-y-1">
        {title != null && <p className="font-semibold">{title}</p>}
        {children != null && <div className="leading-5 opacity-90">{children}</div>}
      </div>
      {actions != null && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon = "inbox", title, description, action, className }: {
  icon?: IconName,
  title: ReactNode,
  description?: ReactNode,
  action?: ReactNode,
  className?: string,
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-3 grid size-9 place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
        <Icon name={icon} />
      </div>
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {description != null && <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{description}</p>}
      {action != null && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-foreground/[0.06]", className)} />;
}

// ─── Form controls ───────────────────────────────────────────────────

// No width here: `w-full` is added per control unless the caller sets its own width (see `fullWidth`),
// since a default `w-full` next to a caller's `w-44` would leave stylesheet order to decide.
const fieldClasses = cn(
  "rounded-md border border-input bg-card text-foreground shadow-[0_1px_1px_hsl(var(--foreground)/0.03)]",
  "placeholder:text-muted-foreground/70 focus:border-ring/40 focus:outline-none focus:ring-2 focus:ring-ring/15",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

// `size` replaces the native numeric `size` attribute (character width), which the console never uses.
export const Input = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: "sm" | "md", fullWidth?: boolean }>(
  function Input({ className, size = "sm", fullWidth = true, ...props }, ref) {
    return <input ref={ref} {...props} className={cn(fieldClasses, fullWidth && "w-full", size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3 text-[13px]", className)} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} {...props} className={cn(fieldClasses, "w-full px-3 py-2 text-[13px] leading-6", className)} />;
  },
);

export function Select({ className, children, fullWidth = true, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { fullWidth?: boolean }) {
  return (
    <select {...props} className={cn(fieldClasses, fullWidth && "w-full", "h-7 cursor-pointer pl-2 pr-7 text-xs", className)}>
      {children}
    </select>
  );
}

export function SearchInput({ value, onChange, placeholder, label, className, inputRef }: {
  value: string,
  onChange: (value: string) => void,
  placeholder: string,
  label: string,
  className?: string,
  inputRef?: React.Ref<HTMLInputElement>,
}) {
  return (
    <div className={cn("relative", className)}>
      <Icon name="search" size="sm" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        className="pl-8"
      />
    </div>
  );
}

export function FieldLabel({ children, htmlFor, hint }: { children: ReactNode, htmlFor?: string, hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">{children}</label>
      {hint != null && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

// ─── Segmented control & tabs ────────────────────────────────────────

export function Segmented<Value extends string>({ value, options, onChange, label, size = "sm" }: {
  value: Value,
  options: ReadonlyArray<{ value: Value, label: ReactNode, count?: number }>,
  onChange: (value: Value) => void,
  label: string,
  size?: "xs" | "sm",
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center rounded-lg border border-border bg-muted/70 p-0.5">
      {options.map(option => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors hover:transition-none",
              focusRing,
              size === "xs" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
              active ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.count != null && <span className="tabular-nums text-muted-foreground">{option.count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Underlined tab strip. Tabs and panels may be rendered by different components, so they agree on
 * element ids through `tabElementId`/`panelElementId` (built from the caller's `useId()`).
 */
export function tabElementId(id: string, value: string): string {
  return `${id}-tab-${value}`;
}

export function panelElementId(id: string, value: string): string {
  return `${id}-panel-${value}`;
}

export function Tabs<Value extends string>({ id, value, items, onChange, label, bordered = true, className }: {
  id: string,
  value: Value,
  items: ReadonlyArray<{ value: Value, label: ReactNode, count?: number }>,
  onChange: (value: Value) => void,
  label: string,
  /** False when the strip sits on an edge that already has a border (eg. the bottom of a page header). */
  bordered?: boolean,
  className?: string,
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex items-center gap-5", bordered && "border-b border-border", className)}>
      {items.map(item => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            id={tabElementId(id, item.value)}
            type="button"
            role="tab"
            aria-selected={active}
            // Only the active panel is guaranteed to be mounted, and aria-controls must not dangle.
            aria-controls={active ? panelElementId(id, item.value) : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={event => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const index = items.findIndex(candidate => candidate.value === value);
              const next = items[(index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
              onChange(next.value);
              document.getElementById(tabElementId(id, next.value))?.focus();
            }}
            className={cn(
              "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 text-[13px] font-medium transition-colors hover:transition-none focus-visible:outline-none",
              active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
            {item.count != null && (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">{item.count.toLocaleString()}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, value, hidden = false, className, children }: {
  id: string,
  value: string,
  /** Keep the panel mounted but hidden, for panels whose state must survive switching away. */
  hidden?: boolean,
  className?: string,
  children: ReactNode,
}) {
  return (
    <div role="tabpanel" id={panelElementId(id, value)} aria-labelledby={tabElementId(id, value)} hidden={hidden} className={className}>
      {children}
    </div>
  );
}

// ─── Description list ────────────────────────────────────────────────

export function PropertyList({ items, className }: {
  items: ReadonlyArray<{ label: string, value: ReactNode, mono?: boolean, hidden?: boolean }>,
  className?: string,
}) {
  return (
    <dl className={cn("divide-y divide-border", className)}>
      {items.filter(item => item.hidden !== true).map(item => (
        <div key={item.label} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-2 text-xs">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className={cn("min-w-0 break-words text-foreground", item.mono === true && "font-mono text-[11.5px]")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
