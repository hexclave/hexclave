"use client";

import { Typography } from "@hexclave/ui";
import { useStackApp } from "../..";
import { useTranslation } from "../../lib/translations";
import { MessageCard } from "./message-card";

export function PredefinedMessageCard({
  type,
  fullPage=false,
}: {
  type: 'signedIn' | 'signedOut' | 'emailSent' | 'passwordReset' | 'unknownError' | 'signUpDisabled',
  fullPage?: boolean,
}) {
  const hexclaveApp = useStackApp();
  const { t } = useTranslation();

  let title: string;
  let message: string | null = null;
  let primaryButton: string | null = null;
  let secondaryButton: string | null = null;
  let primaryAction: (() => Promise<void> | void) | null = null;
  let secondaryAction: (() => Promise<void> | void) | null = null;

  switch (type) {
    case 'signedIn': {
      title = t("You are already signed in");
      primaryAction = () => hexclaveApp.redirectToHome();
      if (!hexclaveApp.isExternalAuthApp()) {
        secondaryAction = () => hexclaveApp.redirectToSignOut();
        secondaryButton = t("Sign out");
      }
      primaryButton = t("Go home");
      break;
    }
    case 'signedOut': {
      title = t("You are not currently signed in.");
      primaryAction = () => hexclaveApp.redirectToSignIn();
      primaryButton = t("Sign in");
      break;
    }
    case 'signUpDisabled': {
      title = t("Sign up for new users is not enabled at the moment.");
      primaryAction = () => hexclaveApp.redirectToHome();
      secondaryAction = () => hexclaveApp.redirectToSignIn();
      primaryButton = t("Go home");
      secondaryButton = t("Sign in");
      break;
    }
    case 'emailSent': {
      title = t("Email sent!");
      message = t("If the user with this e-mail address exists, an e-mail was sent to your inbox. Make sure to check your spam folder.");
      primaryAction = () => hexclaveApp.redirectToHome();
      primaryButton = t("Go home");
      break;
    }
    case 'passwordReset': {
      title = t("Password reset successfully!");
      message = t("Your password has been reset. You can now sign in with your new password.");
      primaryAction = () => hexclaveApp.redirectToSignIn({ noRedirectBack: true });
      primaryButton = t("Sign in");
      break;
    }
    case 'unknownError': {
      title = t("An unknown error occurred");
      message = t("Please try again and if the problem persists, contact support.");
      primaryAction = () => hexclaveApp.redirectToHome();
      primaryButton = t("Go home");
      break;
    }
  }

  return (
    <MessageCard
      title={title}
      fullPage={fullPage}
      primaryButtonText={primaryButton}
      primaryAction={primaryAction}
      secondaryButtonText={secondaryButton || undefined}
      secondaryAction={secondaryAction || undefined}
    >
      {message && <Typography>{message}</Typography>}
    </MessageCard>
  );
}
