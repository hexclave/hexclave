'use client';

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Typography } from "@hexclave/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCard } from "../components/message-cards/message-card";
import { useTranslation } from "../lib/translations";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { useStackApp } from "../lib/hooks";

/**
 * Human side of Hexclave agent auth. The agent (an LLM tool, a bot, ...) has
 * called /agent/register and sent the user here with a short claim code. This
 * page shows who is asking, and Approve mints the agent its own session on
 * the current user's account — a normal session that appears in account
 * settings under the agent's name and can be revoked there.
 *
 * The hook handles the protocol; the component is just one possible UI.
 */

export type AgentAuthConfirmationAgent = {
  name: string,
  description: string | null,
  url: string | null,
};

export type AgentAuthConfirmationStatus =
  | "invalid"
  | "loading"
  | "redirecting"
  | "ready"
  | "approving"
  | "denying"
  | "approved"
  | "denied"
  | "error";

export type AgentAuthConfirmationState = {
  status: AgentAuthConfirmationStatus,
  claimCode: string | null,
  agent: AgentAuthConfirmationAgent | null,
  userHint: string | null,
  expiresAt: Date | null,
  error: Error | null,
  isLoading: boolean,
  approve: () => Promise<void>,
  deny: () => Promise<void>,
  retry: () => void,
};

type ConfirmResponse = {
  agent: AgentAuthConfirmationAgent,
  user_hint: string | null,
  expires_at_millis: number,
  status: "pending" | "approved" | "denied",
};

function getError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isConfirmResponse(data: unknown): data is ConfirmResponse {
  if (typeof data !== "object" || data === null) return false;
  if (!("agent" in data) || !("status" in data) || !("expires_at_millis" in data) || !("user_hint" in data)) return false;
  const agent: unknown = data.agent;
  return typeof agent === "object" && agent !== null && "name" in agent && typeof agent.name === "string";
}

async function postAgentConfirm(app: StackClientApp, claimCode: string, action: "inspect" | "approve" | "deny"): Promise<ConfirmResponse> {
  const result = await app[hexclaveAppInternalsSymbol].sendRequest("/agent/register/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim_code: claimCode, action }),
  });
  if (!result.ok) {
    // The backend's message for known errors (invalid code, expired, already
    // used) is written for end users, so it is safe to surface directly.
    throw new Error(`Agent authorization failed: ${result.status} ${await result.text()}`);
  }
  const data: unknown = await result.json();
  if (!isConfirmResponse(data)) {
    throw new Error("Unexpected response from the agent authorization endpoint");
  }
  return data;
}

export function useAgentAuthConfirmation(): AgentAuthConfirmationState {
  const app = useStackApp();
  const user = app.useUser({ includeRestricted: true });
  const [claimCode] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("code");
  });
  const [status, setStatus] = useState<Exclude<AgentAuthConfirmationStatus, "invalid">>("loading");
  const [details, setDetails] = useState<ConfirmResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Bumping this re-runs the inspection effect; the effect's other deps
  // (app, claimCode, user) do not change on a retry.
  const [inspectRun, setInspectRun] = useState(0);
  const actionInProgressRef = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    // `user` is re-fetched after approve/deny (a new session was minted on the
    // account), which re-runs this effect; only inspect while we are actually
    // waiting for the initial inspection, never overwrite a later state.
    if (claimCode == null || statusRef.current !== "loading") return;
    let cancelled = false;
    runAsynchronouslyWithAlert(async () => {
      try {
        if (user == null) {
          setStatus("redirecting");
          await app.redirectToSignIn({ replace: true });
          return;
        }
        if (user.isRestricted) {
          setStatus("redirecting");
          await (user.isAnonymous ? app.redirectToSignUp({ replace: true }) : app.redirectToOnboarding({ replace: true }));
          return;
        }
        const response = await postAgentConfirm(app, claimCode, "inspect");
        if (cancelled) return;
        setDetails(response);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(getError(err));
        setStatus("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [app, claimCode, user, inspectRun]);

  const runAction = useCallback(async (action: "approve" | "deny") => {
    if (claimCode == null || actionInProgressRef.current) return;
    actionInProgressRef.current = true;
    try {
      setError(null);
      setStatus(action === "approve" ? "approving" : "denying");
      const response = await postAgentConfirm(app, claimCode, action);
      setDetails(response);
      setStatus(action === "approve" ? "approved" : "denied");
    } catch (err) {
      setError(getError(err));
      setStatus("error");
    } finally {
      actionInProgressRef.current = false;
    }
  }, [app, claimCode]);

  const approve = useCallback(async () => await runAction("approve"), [runAction]);
  const deny = useCallback(async () => await runAction("deny"), [runAction]);
  const retry = useCallback(() => {
    setError(null);
    setStatus("loading");
    setInspectRun((run) => run + 1);
  }, []);

  const visibleStatus = claimCode == null ? "invalid" : status;
  return {
    status: visibleStatus,
    claimCode,
    agent: details?.agent ?? null,
    userHint: details?.user_hint ?? null,
    expiresAt: details != null ? new Date(details.expires_at_millis) : null,
    error,
    isLoading: visibleStatus === "loading" || visibleStatus === "redirecting" || visibleStatus === "approving" || visibleStatus === "denying",
    approve,
    deny,
    retry,
  };
}

export function AgentAuthConfirmation({ fullPage = true }: { fullPage?: boolean }) {
  const { t } = useTranslation();
  const agentAuth = useAgentAuthConfirmation();
  const agentName = agentAuth.agent?.name ?? t("The agent");

  if (agentAuth.status === "invalid") {
    return (
      <MessageCard title={t("Invalid Agent Authorization Link")} fullPage={fullPage}>
        <Typography className="text-red-600">
          {t("This link is missing an agent claim code. Ask the agent to start the connection again.")}
        </Typography>
      </MessageCard>
    );
  }

  if (agentAuth.status === "approved") {
    return (
      <MessageCard title={t("Agent Connected")} fullPage={fullPage}>
        <Typography>
          {t("{agentName} can now act on your behalf. You can close this window.", { agentName })}
        </Typography>
        <Typography variant="secondary">
          {t("You can review and revoke the agent's access at any time from your account settings, under active sessions.")}
        </Typography>
      </MessageCard>
    );
  }

  if (agentAuth.status === "denied") {
    return (
      <MessageCard title={t("Agent Denied")} fullPage={fullPage}>
        <Typography>
          {t("{agentName} was not granted access to your account. You can close this window.", { agentName })}
        </Typography>
      </MessageCard>
    );
  }

  if (agentAuth.status === "error") {
    return (
      <MessageCard
        title={t("Agent Authorization Failed")}
        fullPage={fullPage}
        primaryButtonText={t("Try Again")}
        primaryAction={agentAuth.retry}
      >
        <Typography className="text-red-600">
          {agentAuth.error?.message}
        </Typography>
      </MessageCard>
    );
  }

  if (agentAuth.status !== "ready" && agentAuth.status !== "approving" && agentAuth.status !== "denying") {
    return (
      <MessageCard title={t("Loading...")} fullPage={fullPage}>
        <Typography>
          {t("Looking up the agent that is asking for access...")}
        </Typography>
      </MessageCard>
    );
  }

  return (
    <MessageCard
      title={t("Allow {agentName} to access your account?", { agentName })}
      fullPage={fullPage}
      primaryButtonText={agentAuth.status === "approving" ? t("Approving...") : t("Approve")}
      primaryAction={agentAuth.approve}
      secondaryButtonText={agentAuth.status === "denying" ? t("Denying...") : t("Deny")}
      secondaryAction={agentAuth.deny}
    >
      {agentAuth.agent?.description != null && (
        <Typography>{agentAuth.agent.description}</Typography>
      )}
      {agentAuth.agent?.url != null && (
        <Typography variant="secondary" className="break-all">{agentAuth.agent.url}</Typography>
      )}
      {agentAuth.userHint != null && (
        <Typography variant="secondary">
          {t("The agent expects to be approved by {userHint}.", { userHint: agentAuth.userHint })}
        </Typography>
      )}
      <Typography variant="destructive">
        {t("Approving gives the agent its own session with the same permissions as you. It will appear under your active sessions as \"{agentName}\" and you can revoke it there at any time. If you did not expect this request, deny it.", { agentName })}
      </Typography>
    </MessageCard>
  );
}
