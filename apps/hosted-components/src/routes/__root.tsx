/// <reference types="vite/client" />
import * as Sentry from '@sentry/react';
import { HexclaveClientApp, HexclaveProvider, HexclaveTheme } from '@hexclave/react';
import { publishableClientKeyNotNecessarySentinel } from '@hexclave/shared/dist/utils/oauth';
import { runAsynchronously } from '@hexclave/shared/dist/utils/promises';
import { validateRedirectUrl } from '@hexclave/shared/dist/utils/redirect-urls';
import { isRelative } from '@hexclave/shared/dist/utils/urls';
import { throwErr } from '@hexclave/shared/dist/utils/errors';
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useNavigate
} from '@tanstack/react-router';
import type { ErrorInfo, ReactNode } from 'react';
import { Component, useMemo, useSyncExternalStore } from 'react';
import '../styles.css';


export function getProjectId(): string | null {
  // Extract from either cloud subdomain:
  // <projectId>.built-with-hexclave.com or the legacy <projectId>.built-with-stack-auth.com.
  // Also works with <projectId>.localhost for local dev
  const hostname = window.location.hostname;
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts[0];
  }

  return null;
}

function getProjectIdSnapshot(): string | null | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return getProjectId();
}

function subscribeToProjectIdSnapshot(onStoreChange: () => void) {
  const timeoutId = window.setTimeout(onStoreChange, 0);
  return () => window.clearTimeout(timeoutId);
}

function useProjectIdFromHostname(): string | null | undefined {
  return useSyncExternalStore(
    subscribeToProjectIdSnapshot,
    getProjectIdSnapshot,
    () => undefined,
  );
}

function getApiBaseUrlFromEnv(): string | undefined {
  const hexclaveValue = import.meta.env.VITE_HEXCLAVE_API_URL;
  const stackValue = import.meta.env.VITE_STACK_API_URL;
  if (hexclaveValue && stackValue && hexclaveValue !== stackValue) {
    throw new Error("Environment variables VITE_HEXCLAVE_API_URL and VITE_STACK_API_URL are both set to different values. Remove one of them or set them to the same value.");
  }
  return hexclaveValue || stackValue || undefined;
}

function isTrustedNavigationTarget(to: string): boolean {
  return isRelative(to) || validateRedirectUrl(to, { trustedDomains: [window.location.origin] });
}

function useHostedComponentsNavigate() {
  const navigate = useNavigate();

  return useMemo(() => (to: string) => {
    runAsynchronously(async () => {
      if (to.startsWith("#")) {
        await navigate({ hash: to.slice(1) });
      } else {
        if (!isTrustedNavigationTarget(to)) {
          throw new Error("Refusing to navigate to an untrusted URL");
        }
        await navigate({ href: to });
      }
    });
  }, [navigate]);
}

function FullPageError({ title, message }: { title: string, message: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <div style={{ textAlign: 'center', maxWidth: 480, padding: 24 }}>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: '#666' }}>{message}</p>
      </div>
    </div>
  );
}

function FullPageLoadingSkeleton() {
  return (
    <div className="hexclave-hosted-loading-skeleton">
      <div
        aria-label="Loading"
        aria-busy="true"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
          width: '100%',
          maxWidth: 380,
        }}
      >
        <div className="hexclave-hosted-loading-block" style={{ width: 48, height: 48, borderRadius: 12 }} />
        <div className="hexclave-hosted-loading-block" style={{ width: '60%', height: 20, borderRadius: 999 }} />
        <div className="hexclave-hosted-loading-block hexclave-hosted-loading-block-subtle" style={{ width: '82%', height: 14, borderRadius: 999 }} />
        <div className="hexclave-hosted-loading-block hexclave-hosted-loading-block-subtle" style={{ width: '70%', height: 14, borderRadius: 999 }} />
      </div>
      <style>{`
        .hexclave-hosted-loading-skeleton {
          align-items: center;
          background: #ffffff;
          display: flex;
          justify-content: center;
          min-height: 100vh;
          padding: 24px;
        }

        .hexclave-hosted-loading-block {
          animation: hexclave-hosted-loading-pulse 1.5s ease-in-out infinite;
          background: rgba(228, 228, 231, 0.72);
        }

        .hexclave-hosted-loading-block-subtle {
          background: rgba(244, 244, 245, 0.86);
        }

        @media (prefers-color-scheme: dark) {
          .hexclave-hosted-loading-skeleton {
            background: #09090b;
          }

          .hexclave-hosted-loading-block {
            background: rgba(39, 39, 42, 0.72);
          }

          .hexclave-hosted-loading-block-subtle {
            background: rgba(39, 39, 42, 0.48);
          }
        }

        @keyframes hexclave-hosted-loading-pulse {
          50% {
            opacity: 0.58;
          }
        }
      `}</style>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
    console.error('Hosted components error:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return <FullPageError title="Something went wrong" message={this.state.error.message} />;
    }

    return this.props.children;
  }
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body style={{ fontFamily: "'Inter', sans-serif", margin: 0 }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const projectId = useProjectIdFromHostname();

  const isValidProjectId = projectId ? (projectId === "internal" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) : false;

  const hexclaveApp = useMemo(() => {
    if (!projectId || !isValidProjectId) return null;
    return new HexclaveClientApp({
      projectId,
      publishableClientKey: publishableClientKeyNotNecessarySentinel,
      tokenStore: "cookie",
      baseUrl: getApiBaseUrlFromEnv(),
      telemetry: { resource: { service: { name: "hosted-components" } } },
      urls: {
        handler: "/handler",
        signIn: "/handler/sign-in",
        signUp: "/handler/sign-up",
        forgotPassword: "/handler/forgot-password",
        passwordReset: "/handler/password-reset",
        emailVerification: "/handler/email-verification",
        accountSettings: "/handler/account-settings",
        mfa: { type: "custom", url: "/handler/mfa", version: 1 },
        error: { type: "custom", url: "/handler/error", version: 1 },
        teamInvitation: { type: "custom", url: "/handler/team-invitation", version: 1 },
        cliAuthConfirm: { type: "custom", url: "/handler/cli-auth-confirm", version: 1 },
        onboarding: { type: "custom", url: "/handler/onboarding", version: 1 },
        afterSignIn: "/",
        afterSignUp: "/",
        afterSignOut: "/handler/sign-in",
      },
      redirectMethod: { useNavigate: useHostedComponentsNavigate },
    });
  }, [isValidProjectId, projectId]);

  if (projectId === undefined) {
    return <FullPageLoadingSkeleton />;
  }

  if (!projectId) {
    return <FullPageError title="Invalid URL" message={`Could not determine project ID from subdomain. Visit <projectId>.${window.location.host}.`} />;
  }

  if (!isValidProjectId) {
    return <FullPageError title="Something went wrong" message={`Invalid project ID: ${projectId}. Project IDs must be UUIDs.`} />;
  }

  const app = hexclaveApp ?? throwErr("RootComponent expected a HexclaveClientApp after project ID validation.");

  return (
    <ErrorBoundary>
      <HexclaveProvider app={app}>
        <HexclaveTheme>
          <Outlet />
        </HexclaveTheme>
      </HexclaveProvider>
    </ErrorBoundary>
  );
}
