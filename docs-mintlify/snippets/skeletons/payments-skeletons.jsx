// Lightweight, decorative skeletons used to illustrate the Payments app.
// They are intentionally non-interactive and use neutral placeholders so they
// read as "examples" rather than live UI.
//
// NOTE: Mintlify evaluates each exported component in isolation, so every
// component must be fully self-contained — no shared module-level constants or
// helper components. That's why ACCENT / Frame are redefined inside each one.

export const PricingSkeleton = () => {
  const ACCENT = "#10b981";

  const Frame = ({ label, children }) => (
    <div className="overflow-hidden rounded-2xl border border-zinc-950/10 bg-white dark:border-white/10 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-950/10 bg-zinc-950/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
        </div>
        <span className="ml-1 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );

  const tier = (name, price, highlighted) => (
    <div
      className={
        "flex flex-col gap-3 rounded-xl border p-3 " +
        (highlighted
          ? "border-transparent ring-2"
          : "border-zinc-950/[0.08] dark:border-white/[0.08]")
      }
      style={highlighted ? { boxShadow: `0 0 0 2px ${ACCENT}` } : undefined}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-200">{name}</span>
        {highlighted && (
          <span
            className="rounded-full px-2 py-0.5 text-[9px] font-semibold text-white"
            style={{ backgroundColor: ACCENT }}
          >
            Popular
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[18px] font-bold text-zinc-800 dark:text-zinc-100">{price}</span>
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500">/mo</span>
      </div>
      <div className="flex flex-col gap-1.5 pt-1">
        {["80%", "65%", "72%"].map((w, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ACCENT, opacity: 0.6 }} />
            <div className="h-2 rounded-full bg-zinc-200/90 dark:bg-zinc-700/80" style={{ width: w }} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label='Product line: "Plan"'>
        <div className="grid grid-cols-3 gap-2.5">
          {tier("Free", "$0", false)}
          {tier("Pro", "$20", true)}
          {tier("Enterprise", "$99", false)}
        </div>
      </Frame>
    </div>
  );
};

export const EntitlementsSkeleton = () => {
  const ACCENT = "#10b981";

  const Frame = ({ label, children }) => (
    <div className="overflow-hidden rounded-2xl border border-zinc-950/10 bg-white dark:border-white/10 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-950/10 bg-zinc-950/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
        </div>
        <span className="ml-1 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );

  const meter = (label, value, pct) => (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-950/[0.06] p-3 dark:border-white/[0.06]">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className="h-full rounded-full" style={{ width: pct, backgroundColor: ACCENT }} />
      </div>
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="user.useItem(…)">
        <div className="grid grid-cols-3 gap-2.5">
          {meter("Credits", "820", "82%")}
          {meter("Seats", "4 / 5", "80%")}
          {meter("API quota", "12k", "47%")}
        </div>
      </Frame>
    </div>
  );
};

export const TransactionsSkeleton = () => {
  const Frame = ({ label, children }) => (
    <div className="overflow-hidden rounded-2xl border border-zinc-950/10 bg-white dark:border-white/10 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-950/10 bg-zinc-950/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
        </div>
        <span className="ml-1 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );

  const row = (amount, status, color) => (
    <div className="flex items-center justify-between border-b border-zinc-950/[0.06] py-2.5 last:border-b-0 dark:border-white/[0.06]">
      <div className="flex items-center gap-2.5">
        <div className="h-6 w-6 rounded-md bg-zinc-100 dark:bg-zinc-800" />
        <div className="flex flex-col gap-1.5">
          <div className="h-2 w-24 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="h-1.5 w-16 rounded-full bg-zinc-200 dark:bg-zinc-700" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-200">{amount}</span>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: color + "22", color }}
        >
          {status}
        </span>
      </div>
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="Transactions">
        <div className="flex flex-col">
          {row("$20.00", "Paid", "#10b981")}
          {row("$99.00", "Renewed", "#10b981")}
          {row("$20.00", "Refunded", "#f59e0b")}
          {row("$20.00", "Failed", "#ef4444")}
        </div>
      </Frame>
    </div>
  );
};
