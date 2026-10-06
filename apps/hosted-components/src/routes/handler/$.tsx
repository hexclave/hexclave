import { createFileRoute, useLocation } from '@tanstack/react-router';
import { HexclaveHandler, hexclaveAppInternalsSymbol, useStackApp } from '@hexclave/react';
import type { ReactNode } from "react";
import { DevelopmentPageNote, type DevelopmentPageKey } from "~/components/development-page-note";
import { HostedAccountSettings } from '../../hosted-components/account-settings/index';
import {
  HostedEmailVerification,
  HostedError,
  HostedForgotPassword,
  HostedMagicLinkCallback,
  HostedMfa,
  HostedPasswordReset,
  HostedSignIn,
  HostedSignUp,
  HostedTeamInvitation,
  HostedAgentAuthConfirm,
  HostedCliAuthConfirm,
  HostedOnboarding,
} from '../../hosted-components/auth';
import { HostedAuthMessage } from '../../hosted-components/auth/supporting/layout';
import { requiresAfterAuthReturn } from './after-auth-return-policy';
import { isCanonicalHandlerPathOrAlias } from './handler-path-policy';

export const Route = createFileRoute('/handler/$')({
  component: HandlerPage,
});

type HostedPage = {
  pageKey?: DevelopmentPageKey,
  render: () => ReactNode,
};

const hostedPages = new Map<string, HostedPage>([
  ["account-settings", {
    pageKey: "accountSettings",
    render: () => <HostedAccountSettings fullPage />,
  }],
  ["sign-in", {
    pageKey: "signIn",
    render: () => <HostedSignIn fullPage automaticRedirect />,
  }],
  ["log-in", {
    pageKey: "signIn",
    render: () => <HostedSignIn fullPage automaticRedirect />,
  }],
  ["sign-up", {
    pageKey: "signUp",
    render: () => <HostedSignUp fullPage automaticRedirect />,
  }],
  ["register", {
    pageKey: "signUp",
    render: () => <HostedSignUp fullPage automaticRedirect />,
  }],
  ["forgot-password", {
    pageKey: "forgotPassword",
    render: () => <HostedForgotPassword fullPage />,
  }],
  ["password-reset", {
    pageKey: "passwordReset",
    render: () => <HostedPasswordReset fullPage />,
  }],
  ["email-verification", {
    pageKey: "emailVerification",
    render: () => <HostedEmailVerification fullPage />,
  }],
  ["magic-link-callback", {
    render: () => <HostedMagicLinkCallback fullPage />,
  }],
  ["mfa", {
    pageKey: "mfa",
    render: () => <HostedMfa fullPage />,
  }],
  ["error", {
    pageKey: "error",
    render: () => <HostedError fullPage />,
  }],
  ["team-invitation", {
    pageKey: "teamInvitation",
    render: () => <HostedTeamInvitation fullPage />,
  }],
  ["cli-auth-confirm", {
    pageKey: "cliAuthConfirm",
    render: () => <HostedCliAuthConfirm fullPage />,
  }],
  ["agent-auth-confirm", {
    pageKey: "agentAuthConfirm",
    render: () => <HostedAgentAuthConfirm fullPage />,
  }],
  ["onboarding", {
    pageKey: "onboarding",
    render: () => <HostedOnboarding fullPage />,
  }],
]);

function HandlerPage() {
  const location = useLocation();
  const app = useStackApp();
  const handlerPath = getHostedHandlerPath(location.pathname);
  const hostedPage = hostedPages.get(handlerPath);
  const searchParams = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

  if (
    requiresAfterAuthReturn({ handlerPath, searchParams })
    && app[hexclaveAppInternalsSymbol].getRawAfterAuthReturnTo() == null
  ) {
    return <MissingAfterAuthReturn />;
  }

  if (hostedPage == null) {
    return isCanonicalHandlerPathOrAlias(handlerPath)
      ? <HexclaveHandler fullPage />
      : <UnknownHandlerPath handlerPath={handlerPath} />;
  }

  return (
    <WithDevelopmentPageNote pageKey={hostedPage.pageKey}>
      {hostedPage.render()}
    </WithDevelopmentPageNote>
  );
}

function UnknownHandlerPath(props: {
  handlerPath: string,
}) {
  return (
    <HostedAuthMessage
      title="Hosted page not found"
      primaryAction={() => window.history.back()}
      primaryText="Back"
      fullPage
    >
      The hosted handler path <code>{props.handlerPath || "/"}</code> is not recognized. Go back to the website that opened it, or close this tab.
    </HostedAuthMessage>
  );
}

function MissingAfterAuthReturn() {
  return (
    <HostedAuthMessage
      title="Return URL is missing"
      primaryAction={() => window.history.back()}
      primaryText="Go back"
      fullPage
    >
      This authentication page was opened without an <code>after_auth_return_to</code> URL. Go
      back to the website and start the flow there. If you maintain the website, use the SDK
      redirect helpers instead of linking to this hosted page directly.
    </HostedAuthMessage>
  );
}

function WithDevelopmentPageNote(props: {
  pageKey?: DevelopmentPageKey,
  children: ReactNode,
}) {
  return (
    <>
      {props.children}
      <DevelopmentPageNote pageKey={props.pageKey} />
    </>
  );
}

function getHostedHandlerPath(pathname: string) {
  const handlerSegment = '/handler/';
  const handlerIndex = pathname.indexOf(handlerSegment);
  if (handlerIndex === -1) {
    return "";
  }

  return pathname.slice(handlerIndex + handlerSegment.length).replace(/^\/+|\/+$/g, "");
}
