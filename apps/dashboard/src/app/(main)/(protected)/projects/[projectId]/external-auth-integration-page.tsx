"use client";

import { useUpdateConfig } from "@/components/config-update";
import { DesignAlert, DesignButton, DesignCard, DesignInput } from "@/components/design-components";
import { getWorkOSVerificationUrls } from "@hexclave/shared/dist/interface/external-auth";
import { FingerprintSimpleIcon, KeyIcon, LinkSimpleIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { AppEnabledGuard } from "./app-enabled-guard";
import { PageLayout } from "./page-layout";
import { useAdminApp } from "./use-admin-app";

type ExternalAuthIntegrationProvider = "clerk" | "better-auth" | "workos";

const providerDetails = {
  clerk: {
    appId: "clerk-integration",
    displayName: "Clerk",
    description: "Let Clerk own session refresh while Hexclave issues short-lived access tokens.",
  },
  "better-auth": {
    appId: "better-auth-integration",
    displayName: "Better Auth",
    description: "Exchange Better Auth JWTs for short-lived Hexclave access tokens.",
  },
  workos: {
    appId: "workos-integration",
    displayName: "WorkOS",
    description: "Use WorkOS AuthKit sessions without storing WorkOS credentials in Hexclave.",
  },
} as const;

const setupSnippets = {
  clerk: `tokenStore: clerkTokenStore({
  getSessionId: () => clerk.session?.id ?? null,
  getToken: async () => await clerk.session?.getToken() ?? null,
  subscribe: (callback) => clerk.addListener(callback),
  signOut: async () => await clerk.signOut(),
})`,
  "better-auth": `tokenStore: betterAuthTokenStore({
  getSessionId: getBetterAuthSessionId,
  getToken: getBetterAuthJwt,
  subscribe: onBetterAuthSessionChange,
  signOut: signOutOfBetterAuth,
})`,
  workos: `tokenStore: workosTokenStore({
  getSessionId: getWorkOSSessionId,
  getToken: getWorkOSAccessToken,
  subscribe: onWorkOSSessionChange,
  signOut: signOutOfWorkOS,
})`,
} as const;

function SetupSnippet(props: { provider: ExternalAuthIntegrationProvider, providerName: string }) {
  return (
    <DesignCard title="SDK setup" icon={KeyIcon} gradient="default">
      <p className="mb-3 text-sm text-muted-foreground">
        Pass callbacks from {props.providerName}; the provider SDK remains responsible for refreshing its token.
      </p>
      <pre className="overflow-x-auto rounded-xl border border-border bg-foreground/[0.03] p-4 text-xs">
        <code>{setupSnippets[props.provider]}</code>
      </pre>
    </DesignCard>
  );
}

export function ExternalAuthIntegrationPage(props: { provider: ExternalAuthIntegrationProvider }) {
  const details = providerDetails[props.provider];
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const initialValues = (() => {
    switch (props.provider) {
      case "clerk": {
        return {
          issuer: config["clerk-integration"].issuer ?? "",
          authorizedParties: config["clerk-integration"].authorizedParties ?? "",
          audience: "",
          jwksUrl: "",
          clientId: "",
        };
      }
      case "better-auth": {
        return {
          issuer: config["better-auth-integration"].issuer ?? "",
          authorizedParties: "",
          audience: config["better-auth-integration"].audience ?? "",
          jwksUrl: config["better-auth-integration"].jwksUrl ?? "",
          clientId: "",
        };
      }
      case "workos": {
        return {
          issuer: config["workos-integration"].issuer ?? "",
          authorizedParties: "",
          audience: "",
          jwksUrl: "",
          clientId: config["workos-integration"].clientId ?? "",
        };
      }
    }
  })();
  const [issuer, setIssuer] = useState(initialValues.issuer);
  const [authorizedParties, setAuthorizedParties] = useState(initialValues.authorizedParties);
  const [audience, setAudience] = useState(initialValues.audience);
  const [jwksUrl, setJwksUrl] = useState(initialValues.jwksUrl);
  const [clientId, setClientId] = useState(initialValues.clientId);
  const workosDerivedUrls = props.provider === "workos" && clientId.length > 0
    ? getWorkOSVerificationUrls(clientId, issuer.length === 0 ? undefined : issuer)
    : null;

  const save = async () => {
    switch (props.provider) {
      case "clerk": {
        await updateConfig({
          adminApp,
          configUpdate: {
            "clerk-integration.issuer": issuer.length === 0 ? null : issuer,
            "clerk-integration.authorizedParties": authorizedParties,
          },
          pushable: true,
        });
        return;
      }
      case "better-auth": {
        await updateConfig({
          adminApp,
          configUpdate: {
            "better-auth-integration.issuer": issuer.length === 0 ? null : issuer,
            "better-auth-integration.audience": audience,
            // The config schema validates a non-empty value as a URL, so clearing the field must send null.
            "better-auth-integration.jwksUrl": jwksUrl.length === 0 ? null : jwksUrl,
          },
          pushable: true,
        });
        return;
      }
      case "workos": {
        await updateConfig({
          adminApp,
          configUpdate: {
            "workos-integration.clientId": clientId,
            "workos-integration.issuer": issuer.length === 0 ? null : issuer,
          },
          pushable: true,
        });
        return;
      }
    }
  };

  return (
    <AppEnabledGuard appId={details.appId}>
      <PageLayout
        title={`${details.displayName} Integration`}
        description={details.description}
      >
        <div className="flex flex-col gap-5">
          <DesignAlert
            variant="info"
            title="External tokens are never stored"
            description="Hexclave stores only the verified identity mapping and a lightweight session correlation row."
          />
          {props.provider === "better-auth" && (
            <DesignAlert
              variant="warning"
              title="Add a signed session ID"
              description="Configure Better Auth's JWT plugin to include the current session ID in a sid claim. Hexclave uses it to correlate and revoke individual sessions."
            />
          )}
          <DesignCard title="Provider configuration" icon={ShieldCheckIcon} gradient="blue">
            <div className="flex flex-col gap-4">
              {props.provider === "workos" && (
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Client ID
                  <DesignInput value={clientId} onChange={event => setClientId(event.target.value)} placeholder="client_..." />
                  <span className="text-xs font-normal text-muted-foreground">Used to derive the WorkOS JWKS endpoint and validate the token client.</span>
                </label>
              )}
              <label className="flex flex-col gap-2 text-sm font-medium">
                {props.provider === "workos" ? "Issuer override (advanced, optional)" : "Issuer"}
                <DesignInput value={issuer} onChange={event => setIssuer(event.target.value)} placeholder={props.provider === "workos" ? "Leave blank to derive from Client ID" : "https://issuer.example.com"} leadingIcon={<LinkSimpleIcon />} />
                <span className="text-xs font-normal text-muted-foreground">
                  {props.provider === "workos"
                    ? "Leave blank to use the issuer derived from the Client ID. Only set this for a WorkOS deployment with a different issuer."
                    : "Must exactly match the JWT issuer claim."}
                </span>
              </label>
              {props.provider === "clerk" && (
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Authorized parties (optional)
                  <DesignInput value={authorizedParties} onChange={event => setAuthorizedParties(event.target.value)} placeholder="https://app.example.com, http://localhost:3000" />
                  <span className="text-xs font-normal text-muted-foreground">Leave blank to skip Clerk&apos;s azp allowlist, or enter comma-separated origins accepted in the azp claim.</span>
                </label>
              )}
              {props.provider === "better-auth" && (
                <>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    Audience
                    <DesignInput value={audience} onChange={event => setAudience(event.target.value)} placeholder="your-app" />
                  </label>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    JWKS URL
                    <DesignInput value={jwksUrl} onChange={event => setJwksUrl(event.target.value)} placeholder="https://auth.example.com/api/auth/jwks" />
                    <span className="text-xs font-normal text-muted-foreground">Enable Better Auth&apos;s JWT plugin and enter its public JWKS endpoint.</span>
                  </label>
                </>
              )}
              {workosDerivedUrls != null && (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p>Derived issuer: {workosDerivedUrls.issuer}</p>
                  <p>JWKS URL: {workosDerivedUrls.jwksUrl}</p>
                </div>
              )}
              <div>
                <DesignButton onClick={save}>Save configuration</DesignButton>
              </div>
            </div>
          </DesignCard>
          <SetupSnippet provider={props.provider} providerName={details.displayName} />
          {props.provider === "clerk" && (
            <DesignCard title="Stable session caching" icon={FingerprintSimpleIcon} gradient="default">
              <p className="text-sm text-muted-foreground">
                You can optionally provide getSessionId to keep Hexclave caches stable across Clerk token rotations.
              </p>
            </DesignCard>
          )}
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}
