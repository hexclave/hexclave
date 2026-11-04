'use client';

import { KnownErrors } from "@hexclave/shared";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Button, Label, PasswordInput, Typography } from "@hexclave/ui";
import React from "react";
import { useStackApp } from "..";
import { FormWarningText } from "../components/elements/form-warning";
import { MessageCard } from "../components/message-cards/message-card";
import { useTranslation } from "../lib/translations";

export function EmailVerification(props: {
  searchParams?: Record<string, string>,
  fullPage?: boolean,
}) {
  const { t } = useTranslation();
  const hexclaveApp = useStackApp();
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof hexclaveApp.verifyEmail>> | null>(null);
  const [needsPassword, setNeedsPassword] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const invalidJsx = (
    <MessageCard title={t("Invalid Verification Link")} fullPage={!!props.fullPage}>
      <p>{t("Please check if you have the correct link. If you continue to have issues, please contact support.")}</p>
    </MessageCard>
  );

  const expiredJsx = (
    <MessageCard title={t("Expired Verification Link")} fullPage={!!props.fullPage}>
      <p>{t("Your email verification link has expired. Please request a new verification link from your account settings.")}</p>
    </MessageCard>
  );

  if (!props.searchParams?.code) {
    return invalidJsx;
  }

  const verify = async (passwordToSend?: string) => {
    const code = props.searchParams?.code || throwErr("No verification code provided");
    const verifyResult = await hexclaveApp.verifyEmail(code, { requirePasswordIfSet: true, password: passwordToSend });
    if (verifyResult.status === 'error' && KnownErrors.EmailVerificationRequiresPassword.isInstance(verifyResult.error)) {
      setNeedsPassword(true);
      return;
    }
    if (verifyResult.status === 'error' && KnownErrors.PasswordConfirmationMismatch.isInstance(verifyResult.error)) {
      setPasswordError(t("Wrong password"));
      return;
    }
    setResult(verifyResult);
  };

  if (!result && needsPassword) {
    return (
      <MessageCard title={t("Enter your password")} fullPage={!!props.fullPage}>
        <Typography>{t("To verify this email, enter the password of the account it belongs to.")}</Typography>
        <Typography variant="secondary" type="footnote">{t("If you did not create this account, do not verify it. Someone may have signed up with your email address.")}</Typography>
        <form
          className="flex flex-col items-stretch text-left"
          onSubmit={e => {
            e.preventDefault();
            runAsynchronouslyWithAlert(async () => {
              if (!password) {
                setPasswordError(t("Please enter your password"));
                return;
              }
              setLoading(true);
              try {
                await verify(password);
              } finally {
                setLoading(false);
              }
            });
          }}
          noValidate
        >
          <Label htmlFor="password" className="mb-1">{t("Password")}</Label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            value={password}
            onChange={e => {
              setPassword(e.target.value);
              setPasswordError(null);
            }}
          />
          <FormWarningText text={passwordError ?? undefined} />
          <Button type="submit" className="mt-6" loading={loading}>
            {t("Verify")}
          </Button>
        </form>
      </MessageCard>
    );
  }

  if (!result) {
    return <MessageCard
      title={t("Do you want to verify your email?")}
      fullPage={!!props.fullPage}
      primaryButtonText={t("Verify")}
      primaryAction={async () => {
        await verify();
      }}
      secondaryButtonText={t("Cancel")}
      secondaryAction={async () => {
        await hexclaveApp.redirectToHome();
      }}
    />;
  } else {
    if (result.status === 'error') {
      if (KnownErrors.VerificationCodeNotFound.isInstance(result.error)) {
        return invalidJsx;
      } else if (KnownErrors.VerificationCodeExpired.isInstance(result.error)) {
        return expiredJsx;
      } else if (KnownErrors.VerificationCodeAlreadyUsed.isInstance(result.error)) {
        // everything fine, continue
      } else {
        throw result.error;
      }
    }

    return <MessageCard
      title={t("You email has been verified!")}
      fullPage={!!props.fullPage}
      primaryButtonText={t("Go home")}
      primaryAction={async () => {
        await hexclaveApp.redirectToHome();
      }}
    />;
  }
}
