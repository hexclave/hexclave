import { useCliAuthConfirmation } from "@hexclave/react";
import { KeyRound } from "lucide-react";
import { useState } from "react";

import { Typography } from "~/components/ui";

import { HostedAuthConsentCard, HostedAuthErrorDetails, HostedAuthLoading, HostedAuthMessage } from "./supporting/layout";

export function HostedCliAuthConfirm(props: {
  fullPage?: boolean,
}) {
  const cliAuth = useCliAuthConfirmation();
  const [cancelled, setCancelled] = useState(false);

  if (cancelled) {
    return (
      <HostedAuthMessage title="Authorization cancelled" fullPage={props.fullPage}>
        The CLI application was not authorized. You can close this tab.
      </HostedAuthMessage>
    );
  }

  if (cliAuth.status === "success") {
    return (
      <HostedAuthMessage
        title="CLI Authorized Successfully"
        fullPage={props.fullPage}
      >
        The CLI application has been authorized successfully. You can close this window and return to the command line.
      </HostedAuthMessage>
    );
  }

  if (cliAuth.status === "error") {
    return (
      <HostedAuthMessage
        title="Authorization Failed"
        primaryAction={cliAuth.retry}
        primaryText="Try again"
        secondaryAction={() => setCancelled(true)}
        secondaryText="Cancel"
        fullPage={props.fullPage}
      >
        <HostedAuthErrorDetails
          summary="Failed to authorize the CLI application:"
          detail="This authorization request could not be completed. Please try again."
        />
      </HostedAuthMessage>
    );
  }

  if (cliAuth.status === "invalid") {
    return (
      <HostedAuthMessage
        title="Invalid Authorization Link"
        fullPage={props.fullPage}
      >
        This CLI authorization link is missing a login code. Please return to the command line and start the login process again. You can close this tab.
      </HostedAuthMessage>
    );
  }

  if (cliAuth.status === "authorizing" || cliAuth.status === "redirecting") {
    return <HostedAuthLoading fullPage={props.fullPage} />;
  }

  return (
    <HostedAuthConsentCard
      fullPage={props.fullPage}
      icon={<KeyRound className="h-6 w-6" />}
      title="Authorize CLI Application"
      details={(
        <Typography className="text-sm text-muted-foreground">
          A command line application is requesting access to your account. Clicking authorize will grant a secure access token to the CLI.
        </Typography>
      )}
      warningTitle="Security Warning"
      warning="Make sure you trust the command line application, as it will gain access to your account. If you did not initiate this request, please close this page and ignore it."
      primaryText={cliAuth.isLoading ? "Authorizing..." : "Authorize"}
      primaryAction={cliAuth.authorize}
      secondaryText="Cancel"
      secondaryAction={() => setCancelled(true)}
      disabled={cliAuth.isLoading}
    />
  );
}
