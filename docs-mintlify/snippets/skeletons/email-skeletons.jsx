// Lightweight, decorative skeletons used to illustrate the Emails app.
// They are intentionally non-interactive and use neutral placeholders so they
// read as "examples" rather than live UI.
//
// NOTE: Mintlify evaluates each exported component in isolation, so every
// component must be fully self-contained — no shared module-level constants or
// helper components. That's why ACCENT / Frame are redefined inside each one.

export const EmailPreviewSkeleton = () => {
  const ACCENT = "#6b5df7";

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

  const bodyLine = (w) => (
    <div className="h-2 rounded-full bg-zinc-200/90 dark:bg-zinc-700/80" style={{ width: w }} />
  );

  return (
    <div className="not-prose my-6">
      <Frame label="To: alice@example.com">
        <div className="mx-auto max-w-sm overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <div className="h-6 w-6 rounded-lg" style={{ backgroundColor: ACCENT }} />
            <div className="h-2.5 w-20 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          </div>
          <div className="flex flex-col gap-3 px-4 py-5">
            <div className="h-3 w-40 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            <div className="flex flex-col gap-2 pt-1">
              {bodyLine("100%")}
              {bodyLine("92%")}
              {bodyLine("96%")}
              {bodyLine("60%")}
            </div>
            <div
              className="mt-2 flex h-8 w-32 items-center justify-center rounded-lg text-[12px] font-semibold text-white"
              style={{ backgroundColor: ACCENT }}
            >
              Get started
            </div>
          </div>
          <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <div className="mx-auto h-1.5 w-24 rounded-full bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>
      </Frame>
    </div>
  );
};

export const EmailTemplatesSkeleton = () => {
  const ACCENT = "#6b5df7";

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

  const row = (label, tag) => (
    <div className="flex items-center justify-between border-b border-zinc-950/[0.06] py-2.5 last:border-b-0 dark:border-white/[0.06]">
      <div className="flex items-center gap-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
          <div className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: ACCENT, opacity: 0.55 }} />
        </div>
        <span className="text-[12px] font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      </div>
      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        {tag}
      </span>
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="Templates">
        <div className="flex flex-col">
          {row("Email verification", "Transactional")}
          {row("Password reset", "Transactional")}
          {row("Magic link / OTP", "Transactional")}
          {row("Team invitation", "Transactional")}
          {row("Product update", "Marketing")}
        </div>
      </Frame>
    </div>
  );
};

export const DeliveryStatsSkeleton = () => {
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

  const tile = (label, value, dot) => (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-950/[0.06] p-3 dark:border-white/[0.06]">
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dot }} />
        <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      </div>
      <span className="text-[18px] font-semibold text-zinc-800 dark:text-zinc-100">{value}</span>
      <div className="flex items-end gap-1">
        {[7, 11, 6, 13, 9, 14, 10].map((h, i) => (
          <div
            key={i}
            className="w-1.5 rounded-sm bg-zinc-200 dark:bg-zinc-700"
            style={{ height: h + "px" }}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="Delivery">
        <div className="grid grid-cols-3 gap-2.5">
          {tile("Sent", "8,241", "#10b981")}
          {tile("Bounced", "37", "#f59e0b")}
          {tile("Spam", "4", "#ef4444")}
        </div>
      </Frame>
    </div>
  );
};
