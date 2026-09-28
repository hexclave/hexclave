// Lightweight, decorative skeletons used to illustrate the Authentication app.
// They are intentionally non-interactive and use neutral placeholders so they
// read as "examples" rather than live UI.
//
// NOTE: Mintlify evaluates each exported component in isolation, so every
// component must be fully self-contained — no shared module-level constants or
// helper components. That's why ACCENT / Frame are redefined inside each one.

export const SignInSkeleton = () => {
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

  const provider = (label) => (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="h-3.5 w-3.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
      <span className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  );

  const field = (label) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500">{label}</span>
      <div className="h-8 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/60" />
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="/handler/sign-in">
        <div className="mx-auto flex max-w-xs flex-col gap-3">
          <div className="mb-1 flex flex-col items-center gap-2">
            <div className="h-9 w-9 rounded-xl" style={{ backgroundColor: ACCENT }} />
            <div className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">Sign in</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {provider("Google")}
            {provider("GitHub")}
          </div>
          <div className="flex items-center gap-3 py-0.5">
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
            <span className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">or</span>
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
          </div>
          {field("Email")}
          {field("Password")}
          <div
            className="mt-1 flex h-8 items-center justify-center rounded-lg text-[12px] font-semibold text-white"
            style={{ backgroundColor: ACCENT }}
          >
            Continue
          </div>
        </div>
      </Frame>
    </div>
  );
};

export const AuthMethodsSkeleton = () => {
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

  const toggle = (on) => (
    <div
      className={
        "flex h-4 w-7 items-center rounded-full px-0.5 " +
        (on ? "justify-end" : "justify-start bg-zinc-200 dark:bg-zinc-700")
      }
      style={on ? { backgroundColor: ACCENT } : undefined}
    >
      <div className="h-3 w-3 rounded-full bg-white" />
    </div>
  );

  const row = (label, on) => (
    <div className="flex items-center justify-between border-b border-zinc-950/[0.06] py-2.5 last:border-b-0 dark:border-white/[0.06]">
      <div className="flex items-center gap-2.5">
        <div className="h-5 w-5 rounded-md bg-zinc-200 dark:bg-zinc-700" />
        <span className="text-[12px] font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      </div>
      {toggle(on)}
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="Auth methods">
        <div className="flex flex-col">
          {row("Email & password", true)}
          {row("Magic link / OTP", true)}
          {row("Passkey", true)}
          {row("Google", true)}
          {row("GitHub", true)}
          {row("Microsoft", false)}
        </div>
      </Frame>
    </div>
  );
};

export const UserDirectorySkeleton = () => {
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

  const cell = (w) => <div className="h-2 rounded-full bg-zinc-200/90 dark:bg-zinc-700/80" style={{ width: w }} />;

  const badge = (text, tone) => {
    const tones = {
      green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
      zinc: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
    };
    return (
      <span className={"inline-block rounded-full px-2 py-0.5 text-[10px] font-medium " + tones[tone]}>
        {text}
      </span>
    );
  };

  const row = (initial, color, w1, w2, status) => (
    <div className="grid grid-cols-[1.4fr_1.6fr_0.8fr] items-center gap-3 border-b border-zinc-950/[0.06] px-3 py-2.5 last:border-b-0 dark:border-white/[0.06]">
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ backgroundColor: color }}
        >
          {initial}
        </div>
        {cell(w1)}
      </div>
      {cell(w2)}
      <div>{badge(status[0], status[1])}</div>
    </div>
  );

  return (
    <div className="not-prose my-6">
      <Frame label="Users">
        <div className="overflow-hidden rounded-xl border border-zinc-950/[0.06] dark:border-white/[0.06]">
          <div className="grid grid-cols-[1.4fr_1.6fr_0.8fr] gap-3 border-b border-zinc-950/[0.06] bg-zinc-950/[0.02] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-zinc-500">
            <span>User</span>
            <span>Email</span>
            <span>Status</span>
          </div>
          {row("A", "#6b5df7", "68px", "120px", ["Active", "green"])}
          {row("M", "#0ea5e9", "84px", "104px", ["Active", "green"])}
          {row("S", "#f59e0b", "56px", "132px", ["Invited", "zinc"])}
          {row("R", "#ef4444", "72px", "92px", ["Active", "green"])}
        </div>
      </Frame>
    </div>
  );
};
