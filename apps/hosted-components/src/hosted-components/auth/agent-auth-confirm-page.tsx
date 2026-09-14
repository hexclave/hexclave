import { useAgentAuthConfirmation } from "@hexclave/react";
import { Bot } from "lucide-react";

import { Button, Typography } from "~/components/ui";

import { HostedAuthLoading, HostedAuthMessage, HostedAuthShell } from "./supporting/layout";

export function HostedAgentAuthConfirm(props: {
  fullPage?: boolean,
}) {
  const agentAuth = useAgentAuthConfirmation();
  const agentName = agentAuth.agent?.name ?? "The agent";

  if (agentAuth.status === "approved") {
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
        <div className="flex flex-col gap-1 text-center">
          <Typography className="text-sm text-destructive">
            This agent authorization request could not be completed.
          </Typography>
          <Typography className="text-xs text-muted-foreground font-mono bg-muted p-2 rounded-lg break-all">
            {agentAuth.error?.message}
          </Typography>
        </div>
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
    <HostedAuthShell fullPage={props.fullPage}>
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-6 w-6" />
        </div>
        <Typography type="h2" className="mb-2 text-xl font-semibold tracking-tight">
          Allow {agentName} to access your account?
        </Typography>
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
      </div>

      <div className="mt-6 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-left">
        <Typography className="text-xs font-semibold text-destructive mb-1 uppercase tracking-wider">
          What approving means
        </Typography>
        <Typography className="text-xs text-muted-foreground leading-relaxed">
          The agent gets its own session with the same permissions as you. It will show up under your active sessions as &quot;{agentName}&quot;, where you can revoke it at any time. If you did not expect this request, deny it.
        </Typography>
      </div>

      <div className="mt-6 flex flex-col gap-2.5">
        <Button
          onClick={agentAuth.approve}
          disabled={agentAuth.isLoading}
          className="h-10 rounded-xl font-semibold shadow-sm hover:shadow"
        >
          {agentAuth.status === "approving" ? "Approving..." : "Approve"}
        </Button>
        <Button
          variant="secondary"
          onClick={agentAuth.deny}
          disabled={agentAuth.isLoading}
          className="h-10 rounded-xl font-semibold"
        >
          {agentAuth.status === "denying" ? "Denying..." : "Deny"}
        </Button>
      </div>
    </HostedAuthShell>
  );
}
