"use client";

import * as Sentry from "@sentry/nextjs";
import { recordGlobalErrorRecoveryAttempt } from "./global-error-recovery";
import { useEffect, useRef } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
};

export default function GlobalError({ error }: GlobalErrorProps) {
  const recoveryAttemptRecorded = useRef<boolean | null>(null);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    recoveryAttemptRecorded.current ??= recordGlobalErrorRecoveryAttempt();
    if (!recoveryAttemptRecorded.current) {
      return;
    }
    let cancelled = false;
    setTimeout(() => {
      if (!cancelled) {
        window.location.assign("/");
      }
    }, 3_000);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <html>
      <head>
        <style>{`
          :root {
            color-scheme: light;
            --error-background: #f8fafc;
            --error-foreground: #0f172a;
            --error-muted: #475569;
            --error-card: #ffffff;
            --error-border: #cbd5e1;
            --error-action: #0f172a;
            --error-action-foreground: #ffffff;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              color-scheme: dark;
              --error-background: #0f172a;
              --error-foreground: #f8fafc;
              --error-muted: #cbd5e1;
              --error-card: #1e293b;
              --error-border: #475569;
              --error-action: #f8fafc;
              --error-action-foreground: #0f172a;
            }
          }
          /*
           * The app stylesheet can still load when this boundary replaces the root layout.
           * Keep its ambient pseudo-elements from washing out the recovery UI.
           */
          html {
            background: var(--error-background);
          }
          body {
            box-sizing: border-box;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
            display: grid;
            place-items: center;
            position: relative;
            z-index: 0;
            isolation: isolate;
            background: var(--error-background);
            background-image: none;
            background-blend-mode: normal;
            color: var(--error-foreground);
            font-family: system-ui, sans-serif;
          }
          body::before,
          body::after {
            content: none;
          }
          .error-card {
            position: relative;
            z-index: 1;
            width: min(100%, 440px);
            box-sizing: border-box;
            padding: 32px;
            border: 1px solid var(--error-border);
            border-radius: 16px;
            background: var(--error-card);
            text-align: center;
            box-shadow: 0 12px 32px rgb(15 23 42 / 12%);
          }
          .error-title {
            margin: 0;
            font-size: 24px;
            line-height: 1.25;
          }
          .error-copy {
            margin: 12px 0 24px;
            color: var(--error-muted);
            font-size: 16px;
            line-height: 1.5;
          }
          .error-action {
            border: 0;
            border-radius: 8px;
            padding: 10px 18px;
            background: var(--error-action);
            color: var(--error-action-foreground);
            cursor: pointer;
            font: inherit;
            font-weight: 600;
          }
        `}</style>
      </head>
      <body>
        <main className="error-card">
          <h1 className="error-title">Something went wrong</h1>
          <p className="error-copy">The dashboard could not load this page. Try again, or reload the page manually later.</p>
          <button type="button" className="error-action" onClick={() => window.location.assign("/")}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
