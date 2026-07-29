import { KeyRound } from "lucide-react";

import { Typography } from "~/components/ui";

import { HostedAuthShell } from "./layout";

// The hosted components are only ever served by Hexclave Cloud (on the current or legacy hosted
// subdomain), so we can hardcode the cloud dashboard here; self-hosters use the SDK components instead.
const HOSTED_DASHBOARD_URL = "https://app.hexclave.com";

const configSnippet = `auth: {
  password: { allowSignIn: true },
  otp: { allowSignIn: true },
}`;

/**
 * Shown instead of the sign-in/sign-up form when a project has no auth methods at all (no password,
 * no OTP, no passkey, no OAuth provider). Without this, the page would look broken: there is nothing
 * the end user can do, and the developer gets no hint about what went wrong.
 */
export function HostedNoAuthMethods(props: {
  fullPage?: boolean,
  projectId: string,
  projectDisplayName?: string,
}) {
  const authMethodsUrl = `${HOSTED_DASHBOARD_URL}/projects/${encodeURIComponent(props.projectId)}/app-configuration/authentication`;

  return (
    <HostedAuthShell fullPage={props.fullPage} paddedFullPage={false}>
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-black/[0.08] bg-zinc-100/70 dark:border-white/[0.10] dark:bg-zinc-900/45">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
        </div>
        <Typography type="h2" className="mb-1 text-xl font-semibold tracking-tight">Sign-in is not available</Typography>
        <Typography className="text-sm text-muted-foreground">
          {props.projectDisplayName == null
            ? "This app has no authentication methods enabled, so nobody can sign in yet."
            : <>
              <span className="font-medium text-foreground">{props.projectDisplayName}</span> has no authentication methods enabled, so nobody can sign in yet.
            </>}
        </Typography>
      </div>

      <div className="mt-6 rounded-xl border border-black/[0.08] bg-zinc-100/50 p-4 text-left dark:border-white/[0.10] dark:bg-zinc-900/45">
        <p className="text-sm font-semibold">Are you the developer?</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Enable at least one sign-in method in your <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-xs dark:bg-white/[0.10]">hexclave.config.ts</code>:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-black/[0.06] bg-white/60 p-3 font-mono text-xs leading-relaxed dark:border-white/[0.08] dark:bg-zinc-950/50">{configSnippet}</pre>
        <p className="mt-3 text-sm text-muted-foreground">
          Or turn one on in the{" "}
          <a
            href={authMethodsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline underline-offset-4 transition-colors hover:transition-none hover:text-foreground/80"
          >
            Hexclave dashboard
          </a>
          {" "}under Auth Methods.
        </p>
      </div>
    </HostedAuthShell>
  );
}
