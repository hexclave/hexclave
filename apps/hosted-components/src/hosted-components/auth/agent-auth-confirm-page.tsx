import { useAgentAuthConfirmation } from "@hexclave/react";
import { Bot } from "lucide-react";

import { Typography } from "~/components/ui";

import { HostedAuthConsentCard, HostedAuthErrorDetails, HostedAuthLoading, HostedAuthMessage } from "./supporting/layout";

export function HostedAgentAuthConfirm(props: {
  fullPage?: boolean,
}) {
  const agentAuth = useAgentAuthConfirmation();
  const agentName = agentAuth.agent?.name ?? "The agent";

  if (agentAuth.status === "success") {
    return (
      <HostedAuthMessage title="Agent connected" fullPage={props.fullPage}>
        {agentName} can now act on your behalf. You can review or revoke its access at any time from your account settings, under active sessions. You can close this window.
      </HostedAuthMessage>
    );
  }

  if (agentAuth.status === "denied") {
    return (
      <HostedAuthMessage title="Agent denied" fullPage={props.fullPage}>
        {agentName} was not granted access to your account. You can close this window.
      </HostedAuthMessage>
    );
  }

  if (agentAuth.status === "error") {
    return (
      <HostedAuthMessage
        title="Agent authorization failed"
        primaryAction={agentAuth.retry}
        primaryText="Try again"
        fullPage={props.fullPage}
      >
        <HostedAuthErrorDetails
          summary="This agent authorization request could not be completed."
          detail={agentAuth.error?.message ?? "Unknown error"}
        />
      </HostedAuthMessage>
    );
  }

  if (agentAuth.status === "invalid") {
    return (
      <HostedAuthMessage title="Invalid agent authorization link" fullPage={props.fullPage}>
        This link is missing an agent claim code. Ask the agent to start the connection again. You can close this tab.
      </HostedAuthMessage>
    );
  }

  if (agentAuth.status === "loading" || agentAuth.status === "redirecting") {
    return <HostedAuthLoading fullPage={props.fullPage} />;
  }

  return (
    <HostedAuthConsentCard
      fullPage={props.fullPage}
      icon={<Bot className="h-6 w-6" />}
      title={<>Allow {agentName} to access your account?</>}
      details={(
        <>
          {agentAuth.agent?.description != null && (
            <Typography className="text-sm text-muted-foreground">
              {agentAuth.agent.description}
            </Typography>
          )}
          {agentAuth.agent?.url != null && (
            <Typography className="mt-1 text-xs text-muted-foreground font-mono break-all">
              {agentAuth.agent.url}
            </Typography>
          )}
          {agentAuth.userHint != null && (
            <Typography className="mt-2 text-xs text-muted-foreground">
              The agent expects to be approved by {agentAuth.userHint}.
            </Typography>
          )}
          {agentAuth.claimCode != null && (
            <Typography className="mt-3 text-xs text-muted-foreground">
              Claim code <span className="font-mono">{agentAuth.claimCode}</span>
            </Typography>
          )}
        </>
      )}
      warningTitle="What approving means"
      warning={<>The agent gets its own session with the same permissions as you. It will show up under your active sessions as &quot;{agentName}&quot;, where you can revoke it at any time. If you did not expect this request, deny it.</>}
      primaryText={agentAuth.status === "approving" ? "Approving..." : "Approve"}
      primaryAction={agentAuth.approve}
      secondaryText={agentAuth.status === "denying" ? "Denying..." : "Deny"}
      secondaryAction={agentAuth.deny}
      disabled={agentAuth.isLoading}
    />
  );
}
