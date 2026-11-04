import { KnownErrors } from "@hexclave/shared";
import { useStackApp } from "@hexclave/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useState } from "react";

import { Button, Label, PasswordInput } from "~/components/ui";

import { FormWarningText } from "./supporting/form-elements";
import { HostedAuthHeading, HostedAuthMessage, HostedAuthShell } from "./supporting/layout";
import { getSearchParams } from "./supporting/utils";

export function HostedEmailVerification(props: {
  fullPage?: boolean,
}) {
  const app = useStackApp();
  const searchParams = getSearchParams();
  const code = searchParams.code;
  const [cancelled, setCancelled] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof app.verifyEmail>> | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const invalid = (
    <HostedAuthMessage
      title="Invalid verification link"
      fullPage={props.fullPage}
    >
      This verification link is invalid. Please check the link or request a new verification email. You can close this tab.
    </HostedAuthMessage>
  );

  if (code == null) {
    return invalid;
  }

  if (cancelled) {
    return (
      <HostedAuthMessage title="Verification cancelled" fullPage={props.fullPage}>
        Your email was not verified. You can close this tab.
      </HostedAuthMessage>
    );
  }

  async function verify(verifyCode: string, passwordToSend?: string) {
    const verifyResult = await app.verifyEmail(verifyCode, { requirePasswordIfSet: true, password: passwordToSend });
    if (verifyResult.status === "error" && KnownErrors.EmailVerificationRequiresPassword.isInstance(verifyResult.error)) {
      setNeedsPassword(true);
      return;
    }
    if (verifyResult.status === "error" && KnownErrors.PasswordConfirmationMismatch.isInstance(verifyResult.error)) {
      setPasswordError("Wrong password");
      return;
    }
    setResult(verifyResult);
  }

  if (result == null && needsPassword) {
    return (
      <HostedAuthShell fullPage={props.fullPage}>
        <HostedAuthHeading title="Enter your password">
          To verify this email, enter the password of the account it belongs to.
        </HostedAuthHeading>

        <form
          className="stack-scope flex flex-col items-stretch"
          onSubmit={(event) => {
            event.preventDefault();
            runAsynchronouslyWithAlert(async () => {
              if (password.length === 0) {
                setPasswordError("Please enter your password");
                return;
              }
              setLoading(true);
              try {
                await verify(code, password);
              } finally {
                setLoading(false);
              }
            });
          }}
          noValidate
        >
          <Label htmlFor="password" className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</Label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            className="h-10 rounded-xl border-border bg-background"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordError(null);
            }}
          />
          <FormWarningText text={passwordError} />

          <Button type="submit" className="mt-6 h-10 rounded-xl font-semibold shadow-sm hover:shadow" loading={loading}>
            Verify email
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          If you did not create this account, do not verify it. Someone may have signed up with your email address.
        </p>
      </HostedAuthShell>
    );
  }

  if (result == null) {
    return (
      <HostedAuthMessage
        title="Verify your email"
        primaryText="Verify email"
        primaryAction={async () => {
          await verify(code);
        }}
        secondaryText="Cancel"
        secondaryAction={() => setCancelled(true)}
        fullPage={props.fullPage}
      >
        Confirm that you want to verify this email address for your account.
      </HostedAuthMessage>
    );
  }

  if (result.status === "error") {
    if (KnownErrors.VerificationCodeExpired.isInstance(result.error)) {
      return (
        <HostedAuthMessage
          title="Verification link expired"
          fullPage={props.fullPage}
        >
          This verification link has expired. Please request a new verification email from your account settings. You can close this tab.
        </HostedAuthMessage>
      );
    }
    if (KnownErrors.VerificationCodeAlreadyUsed.isInstance(result.error)) {
      return (
        <HostedAuthMessage
          title="Email already verified"
          fullPage={props.fullPage}
        >
          This verification link has already been used, so your email is already verified. You can close this tab.
        </HostedAuthMessage>
      );
    }
    if (KnownErrors.VerificationCodeNotFound.isInstance(result.error)) {
      return invalid;
    }
    throw result.error;
  }

  return (
    <HostedAuthMessage
      title="Email verified"
      fullPage={props.fullPage}
    >
      Your email has been verified. You can close this tab.
    </HostedAuthMessage>
  );
}
