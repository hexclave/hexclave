"use client";

import { KnownError } from "@hexclave/shared";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { FilterUndefined, filterUndefined } from "@hexclave/shared/dist/utils/objects";
import { use } from "@hexclave/shared/dist/utils/react";
import { getRelativePart } from "@hexclave/shared/dist/utils/urls";
import { notFound, redirect, RedirectType, usePathname, useSearchParams } from 'next/navigation'; // THIS_LINE_PLATFORM next
import { Suspense, useMemo, useSyncExternalStore } from 'react';
/* IF_PLATFORM react
import { useEffect, useRef } from 'react';
// END_PLATFORM */
import { SignIn, SignUp, StackServerApp } from "..";
import { useStackApp } from "../lib/hooks";
import { HandlerUrls, StackClientApp, hexclaveAppInternalsSymbol } from "../lib/hexclave-app";
import { isLocalHandlerUrlTarget, resolveUnknownHandlerPathFallbackUrl } from "../lib/hexclave-app/url-targets";
import { AccountSettings } from "./account-settings";
import { AgentAuthConfirmation } from "./agent-auth-confirm";
import { CliAuthConfirmation } from "./cli-auth-confirm";
import { EmailVerification } from "./email-verification";
import { ErrorPage } from "./error-page";
import { ForgotPassword } from "./forgot-password";
import { MagicLinkCallback } from "./magic-link-callback";
import { MFA } from "./mfa";
import { OAuthCallback } from "./oauth-callback";
import { Onboarding } from "./onboarding";
import { PasswordReset } from "./password-reset";
import { SignOut } from "./sign-out";
import { TeamInvitation } from "./team-invitation";

import { KnownErrorMessageCard } from "../components/message-cards/known-error-message-card";
import { MessageCard } from "../components/message-cards/message-card";
import { PredefinedMessageCard } from "../components/message-cards/predefined-message-card";

type Components = {
  SignIn: typeof SignIn,
  SignUp: typeof SignUp,
  EmailVerification: typeof EmailVerification,
  PasswordReset: typeof PasswordReset,
  ForgotPassword: typeof ForgotPassword,
  SignOut: typeof SignOut,
  OAuthCallback: typeof OAuthCallback,
  MagicLinkCallback: typeof MagicLinkCallback,
  TeamInvitation: typeof TeamInvitation,
  ErrorPage: typeof ErrorPage,
  AccountSettings: typeof AccountSettings,
  CliAuthConfirmation: typeof CliAuthConfirmation,
  AgentAuthConfirmation: typeof AgentAuthConfirmation,
  MFA: typeof MFA,
  Onboarding: typeof Onboarding,
};

type RouteProps = {
  params: Promise<{ stack?: string[] }> | { stack?: string[] },
  searchParams: Promise<Record<string, string>> | Record<string, string>,
};

type RedirectToPageResult =
  | { status: "success" }
  | { status: "known-error", error: KnownError }
  | { status: "unknown-error" };

const availablePaths = {
  signIn: 'sign-in',
  signUp: 'sign-up',
  emailVerification: 'email-verification',
  passwordReset: 'password-reset',
  forgotPassword: 'forgot-password',
  signOut: 'sign-out',
  oauthCallback: 'oauth-callback',
  magicLinkCallback: 'magic-link-callback',
  teamInvitation: 'team-invitation',
  accountSettings: 'account-settings',
  cliAuthConfirm: 'cli-auth-confirm',
  agentAuthConfirm: 'agent-auth-confirm',
  mfa: 'mfa',
  error: 'error',
  onboarding: 'onboarding',
} as const;

const placeholderOrigin = "http://example.com";

const pathAliases = {
  // also includes the uppercase and non-dashed versions
  ...Object.fromEntries(Object.entries(availablePaths).map(([key, value]) => [value, value])),
  "log-in": availablePaths.signIn,
  "register": availablePaths.signUp,
} as const;

export type BaseHandlerProps = {
  fullPage: boolean,
  componentProps?: {
    [K in keyof Components]?: Parameters<Components[K]>[0];
  },
};

function renderComponent(props: {
  path: string,
  searchParams: Record<string, string>,
  fullPage: boolean,
  componentProps?: BaseHandlerProps['componentProps'],
  shouldRedirectToPage?: (name: keyof HandlerUrls) => boolean,
  getDefaultUnknownPathUrl?: (path: string) => string | null,
  onNotFound: () => any,
  app: StackClientApp<any> | StackServerApp<any>,
}) {
  const { path, searchParams, fullPage, componentProps, shouldRedirectToPage, getDefaultUnknownPathUrl, onNotFound, app } = props;

  switch (path) {
    case availablePaths.signIn: {
      if (shouldRedirectToPage?.('signIn')) return { redirectToPage: 'signIn' as const };
      return <SignIn
        fullPage={fullPage}
        automaticRedirect
        {...filterUndefinedINU(componentProps?.SignIn)}
      />;
    }
    case availablePaths.signUp: {
      if (shouldRedirectToPage?.('signUp')) return { redirectToPage: 'signUp' as const };
      return <SignUp
        fullPage={fullPage}
        automaticRedirect
        {...filterUndefinedINU(componentProps?.SignUp)}
      />;
    }
    case availablePaths.emailVerification: {
      if (shouldRedirectToPage?.('emailVerification')) return { redirectToPage: 'emailVerification' as const };
      return <EmailVerification
        searchParams={searchParams}
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.EmailVerification)}
      />;
    }
    case availablePaths.passwordReset: {
      if (shouldRedirectToPage?.('passwordReset')) return { redirectToPage: 'passwordReset' as const };
      return <PasswordReset
        searchParams={searchParams}
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.PasswordReset)}
      />;
    }
    case availablePaths.forgotPassword: {
      if (shouldRedirectToPage?.('forgotPassword')) return { redirectToPage: 'forgotPassword' as const };
      return <ForgotPassword
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.ForgotPassword)}
      />;
    }
    case availablePaths.signOut: {
      if (shouldRedirectToPage?.('signOut')) return { redirectToPage: 'signOut' as const };
      return <SignOut
        searchParams={searchParams}
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.SignOut)}
      />;
    }
    case availablePaths.oauthCallback: {
      if (shouldRedirectToPage?.('oauthCallback')) return { redirectToPage: 'oauthCallback' as const };
      return <OAuthCallback
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.OAuthCallback)}
      />;
    }
    case availablePaths.magicLinkCallback: {
      if (shouldRedirectToPage?.('magicLinkCallback')) return { redirectToPage: 'magicLinkCallback' as const };
      return <MagicLinkCallback
        searchParams={searchParams}
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.MagicLinkCallback)}
      />;
    }
    case availablePaths.teamInvitation: {
      if (shouldRedirectToPage?.('teamInvitation')) return { redirectToPage: 'teamInvitation' as const };
      return <TeamInvitation
        searchParams={searchParams}
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.TeamInvitation)}
      />;
    }
    case availablePaths.accountSettings: {
      return <AccountSettings
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.AccountSettings)}
      />;
    }
    case availablePaths.error: {
      return <ErrorPage
        searchParams={searchParams}
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.ErrorPage)}
      />;
    }
    case availablePaths.cliAuthConfirm: {
      if (shouldRedirectToPage?.('cliAuthConfirm')) return { redirectToPage: 'cliAuthConfirm' as const };
      return <CliAuthConfirmation
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.CliAuthConfirmation)}
      />;
    }
    case availablePaths.agentAuthConfirm: {
      if (shouldRedirectToPage?.('agentAuthConfirm')) return { redirectToPage: 'agentAuthConfirm' as const };
      return <AgentAuthConfirmation
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.AgentAuthConfirmation)}
      />;
    }
    case availablePaths.mfa: {
      if (shouldRedirectToPage?.('mfa')) return { redirectToPage: 'mfa' as const };
      return <MFA
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.MFA)}
      />;
    }
    case availablePaths.onboarding: {
      if (shouldRedirectToPage?.('onboarding')) return { redirectToPage: 'onboarding' as const };
      return <Onboarding
        fullPage={fullPage}
        {...filterUndefinedINU(componentProps?.Onboarding)}
      />;
    }
    default: {
      if (Object.values(availablePaths).includes(path as any)) {
        throw new HexclaveAssertionError(`Path alias ${path} not included in switch statement, but in availablePaths?`, { availablePaths });
      }
      for (const [key, value] of Object.entries(pathAliases)) {
        if (path.toLowerCase().replaceAll('-', '') === key.toLowerCase().replaceAll('-', '')) {
          const redirectUrl = `${app[hexclaveAppInternalsSymbol].getUrls().handler}/${value}?${new URLSearchParams(searchParams).toString()}`;
          return { redirect: redirectUrl };
        }
      }
      const defaultUnknownPathUrl = getDefaultUnknownPathUrl?.(path);
      if (defaultUnknownPathUrl != null) {
        const defaultUnknownPathUrlObject = new URL(defaultUnknownPathUrl, "http://example.com");
        for (const [key, value] of Object.entries(searchParams)) {
          defaultUnknownPathUrlObject.searchParams.set(key, value);
        }
        return { redirect: toAbsoluteOrRelativeRedirectTarget(defaultUnknownPathUrlObject) };
      }
      return onNotFound();
    }
  }
}

export async function getRedirectToPageResult(
  app: StackClientApp,
  redirectToPage: keyof HandlerUrls,
): Promise<RedirectToPageResult> {
  try {
    await app[hexclaveAppInternalsSymbol].redirectToHandler(redirectToPage, { replace: true });
    return { status: "success" };
  } catch (e) {
    if (KnownError.isKnownError(e)) {
      return { status: "known-error", error: e };
    }
    captureError("<HexclaveHandlerClient redirectToPage />", e);
    return { status: "unknown-error" };
  }
}

function RedirectToPage(props: {
  app: StackClientApp,
  fullPage?: boolean,
  redirectToPage: keyof HandlerUrls,
}) {
  const redirectResultPromise = useMemo(
    () => getRedirectToPageResult(props.app, props.redirectToPage),
    [props.app, props.redirectToPage],
  );

  const redirectResult = use(redirectResultPromise);
  if (redirectResult.status === "known-error") {
    return <KnownErrorMessageCard error={redirectResult.error} fullPage={props.fullPage} />;
  }
  if (redirectResult.status === "unknown-error") {
    return <PredefinedMessageCard type="unknownError" fullPage={props.fullPage} />;
  }
  return <MessageCard title="Redirecting..." fullPage={props.fullPage} />;
}

export function HexclaveHandlerClient(props: BaseHandlerProps & Partial<RouteProps> & { location?: string }) {
  // Use hooks to get app
  const hexclaveApp = useStackApp();
  const handlerUrls = hexclaveApp[hexclaveAppInternalsSymbol].getUrls();
  const clientOrigin = useClientOriginAfterHydration();

  // IF_PLATFORM next
  const pathname = usePathname();
  const searchParamsFromHook = useSearchParams();
  const currentLocation = pathname;
  const searchParamsSource = searchParamsFromHook;
  /* ELSE_IF_PLATFORM react
  const navigate = hexclaveApp.useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const currentLocation = props.location ?? (typeof window === "undefined" ? new URL(handlerUrls.handler, placeholderOrigin).pathname : window.location.pathname);
  const searchParamsSource = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const redirectTargets: (string | undefined)[] = [];
  END_PLATFORM */

  const { path, searchParams, handlerPath } = useMemo(() => {
    const handlerPath = new URL(handlerUrls.handler, 'http://example.com').pathname;
    const relativePath = currentLocation.startsWith(handlerPath)
      ? currentLocation.slice(handlerPath.length).replace(/^\/+/, '')
      : currentLocation.replace(/^\/+/, '');

    return {
      path: relativePath,
      searchParams: Object.fromEntries(searchParamsSource.entries()),
      handlerPath,
    };
  }, [currentLocation, searchParamsSource, handlerUrls.handler]);

  const getDefaultUnknownPathUrl = (unknownPath: string): string | null => {
    return resolveUnknownHandlerPathFallbackUrl({
      defaultTarget: hexclaveApp[hexclaveAppInternalsSymbol].getConstructorOptions().urls?.default,
      projectId: hexclaveApp.projectId,
      unknownPath,
    });
  };

  const shouldRedirectToPage = (name: keyof HandlerUrls): boolean => {
    const url = handlerUrls[name];
    const isCrossDomainLocalOauthCallback = name === "oauthCallback" && searchParams.hexclave_cross_domain_auth === "1";
    if (isCrossDomainLocalOauthCallback) {
      return false;
    }
    return !isLocalHandlerUrlTarget({
      targetUrl: url,
      handlerPath,
      currentOrigin: clientOrigin,
    });
  };

  const result = renderComponent({
    path,
    searchParams,
    fullPage: props.fullPage,
    componentProps: props.componentProps,
    shouldRedirectToPage,
    getDefaultUnknownPathUrl,
    onNotFound: () =>
      // IF_PLATFORM next
      notFound()
      /* ELSE_IF_PLATFORM react
      (
        <MessageCard
          title="Page does not exist"
          fullPage={props.fullPage}
          primaryButtonText="Go to Home"
          primaryAction={() => hexclaveApp.redirectToHome()}
        >
          The page you are looking for could not be found. Please check the URL and try again.
        </MessageCard>
      )
      END_PLATFORM */
    ,
    app: hexclaveApp,
  });

  const redirectToPage = (result != null && typeof result === 'object' && 'redirectToPage' in result) ? result.redirectToPage : undefined;

  if (redirectToPage != null) {
    return (
      <Suspense fallback={<MessageCard title="Redirecting..." fullPage={props.fullPage} />}>
        <RedirectToPage app={hexclaveApp} redirectToPage={redirectToPage} fullPage={props.fullPage} />
      </Suspense>
    );
  }

  if (result && 'redirect' in result) {
    // IF_PLATFORM next
    redirect(result.redirect, RedirectType.replace);
    /* ELSE_IF_PLATFORM react
    redirectTargets.push(result.redirect);
    END_PLATFORM */
  }

  /* IF_PLATFORM react
  const redirectTarget = redirectTargets[0];
  const shouldRenderRedirectFallback = redirectTarget != null && hexclaveApp[hexclaveAppInternalsSymbol].getRedirectMethod() === "none";
  useEffect(() => {
    if (redirectTarget == null || shouldRenderRedirectFallback) {
      return;
    }
    navigateRef.current(redirectTarget);
  }, [redirectTarget, shouldRenderRedirectFallback]);

  if (redirectTarget != null && shouldRenderRedirectFallback) {
    return (
      <MessageCard
        title="Continue"
        fullPage={props.fullPage}
        primaryButtonText="Continue"
        primaryAction={() => window.location.assign(redirectTarget)}
      >
        Continue to the next page.
      </MessageCard>
    );
  }

  if (redirectTarget != null) {
    return null;
  }
  END_PLATFORM */

  return result;
}

// filter undefined values in object. if object itself is undefined, return undefined
function filterUndefinedINU<T extends {}>(value: T | undefined): FilterUndefined<T> | undefined {
  return value === undefined ? value : filterUndefined(value);
}

function toAbsoluteOrRelativeRedirectTarget(url: URL): string {
  return url.origin === "http://example.com" ? getRelativePart(url) : url.toString();
}

function useClientOriginAfterHydration(): string | undefined {
  // The first hydrated render must match SSR. After hydration, React re-checks
  // the snapshot and lets us distinguish same-path cross-origin handler URLs.
  return useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => undefined,
  );
}
