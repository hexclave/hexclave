"use client";

import { DashboardRuntimeCodegen } from "@/lib/ai-dashboard/contracts";
import { useDashboardUser } from "@/lib/dashboard-user";
import { getPublicEnvVar } from "@/lib/env";
import { useTheme } from "@/lib/theme";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { memo, useEffect, useMemo, useRef } from "react";
import packageJson from "../../../../package.json";

type DashboardArtifact = {
  prompt: string,
  projectId: string,
  runtimeCodegen: DashboardRuntimeCodegen,
};

function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce<string>((result, str, i) => result + str + (values[i] ?? ''), '');
}
const isDev = process.env.NODE_ENV === "development";

function getEsmFallbackVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return version;
  const patch = Number(parts[2]);
  if (!Number.isInteger(patch) || patch <= 0) return version;
  return `${parts[0]}.${parts[1]}.${patch - 1}`;
}

const ESM_VERSION_HEADER = "// @stack-esm-version:";
const ESM_VERSION_REGEX = /^\/\/\s*@stack-esm-version:\s*(\S+)\s*$/m;

function extractEsmVersion(sourceCode: string): string | null {
  const match = sourceCode.match(ESM_VERSION_REGEX);
  return match ? match[1] : null;
}

export function stampEsmVersion(sourceCode: string, version: string): string {
  if (ESM_VERSION_REGEX.test(sourceCode)) {
    return sourceCode.replace(ESM_VERSION_REGEX, `${ESM_VERSION_HEADER} ${version}`);
  }
  return `${ESM_VERSION_HEADER} ${version}\n${sourceCode}`;
}

function getDependencyScripts(esmVersion: string, esmFallbackVersion: string, dashboardUrl: string): string {
  if (isDev) {
    return html`
      <script type="module">
        function formatDependencyError(error) {
          return error instanceof Error ? error.message : String(error);
        }

        function reportDependencyError(message, error) {
          window.parent.postMessage({
            type: 'dashboard-sandbox-dependency-error',
            message,
            stack: error instanceof Error ? error.stack : undefined,
          }, '*');
        }

        function failDependencyLoad(message, error) {
          reportDependencyError(message, error);
          window.__depsError = {
            message,
            stack: error instanceof Error ? error.stack : undefined,
          };
          window.__depsReady = true;
          window.dispatchEvent(new Event('deps-ready'));
        }

        import React from 'https://esm.sh/react@19.2.3';
        import * as ReactDOM from 'https://esm.sh/react-dom@19.2.3?deps=react@19.2.3';
        import * as ReactDOMClient from 'https://esm.sh/react-dom@19.2.3/client?deps=react@19.2.3';
        import * as Recharts from 'https://esm.sh/recharts@2.15.4?deps=react@19.2.3,react-dom@19.2.3';

        window.React = React;
        window.ReactDOM = { ...ReactDOM, ...ReactDOMClient };
        window.Recharts = Recharts;

        // Stack SDK may not be published at the current version — try with fallback
        try {
          const StackSDK = await import('https://esm.sh/@hexclave/js@${esmVersion}');
          window.StackAdminApp = StackSDK.StackAdminApp;
          window.StackServerApp = StackSDK.StackServerApp;
          window.StackSDK = StackSDK;
        } catch (e) {
          reportDependencyError('[sandbox] @hexclave/js failed at version ${esmVersion}; trying fallback ${esmFallbackVersion}: ' + formatDependencyError(e), e);
          try {
            const StackSDK = await import('https://esm.sh/@hexclave/js@${esmFallbackVersion}');
            window.StackAdminApp = StackSDK.StackAdminApp;
            window.StackServerApp = StackSDK.StackServerApp;
            window.StackSDK = StackSDK;
          } catch (e2) {
            failDependencyLoad('[sandbox] @hexclave/js fallback failed at version ${esmFallbackVersion}: ' + formatDependencyError(e2), e2);
          }
        }
        window.generateUuid = () => crypto.randomUUID();

        // Load local IIFE for dashboard-ui-components (after globals are set)
        const script = document.createElement('script');
        script.src = '${dashboardUrl}/dashboard-ui-components.iife.js';
        script.onload = () => {
          window.__depsReady = true;
          window.dispatchEvent(new Event('deps-ready'));
        };
        script.onerror = (e) => {
          const message = '[sandbox] Failed to load local dashboard-ui-components IIFE bundle. Run pnpm --filter @hexclave/dashboard-ui-components dev or pnpm --filter @hexclave/dashboard-ui-components build so apps/dashboard/public/dashboard-ui-components.iife.js exists.';
          failDependencyLoad(message, e instanceof Error ? e : new Error(message));
        };
        document.head.appendChild(script);
      </script>`;
  }

  return html`
    <script type="module">
      const CUSTOM_DASHBOARD_LOAD_ERROR_MESSAGE = 'There was a problem loading custom dashboards. Please refresh the page and try again.';

      function formatDependencyError(error) {
        return error instanceof Error ? error.message : String(error);
      }

      function reportDependencyError(message, error) {
        window.parent.postMessage({
          type: 'dashboard-sandbox-dependency-error',
          message,
          stack: error instanceof Error ? error.stack : undefined,
        }, '*');
      }

      function failDependencyLoad(message, error) {
        reportDependencyError(message, error);
        window.__depsError = {
          message: CUSTOM_DASHBOARD_LOAD_ERROR_MESSAGE,
          stack: error instanceof Error ? error.stack : undefined,
        };
        window.__depsReady = true;
        window.dispatchEvent(new Event('deps-ready'));
      }

      import React from 'https://esm.sh/react@19.2.3';
      import * as ReactDOM from 'https://esm.sh/react-dom@19.2.3?deps=react@19.2.3';
      import * as ReactDOMClient from 'https://esm.sh/react-dom@19.2.3/client?deps=react@19.2.3';
      import * as Recharts from 'https://esm.sh/recharts@2.15.4?deps=react@19.2.3,react-dom@19.2.3';

      window.React = React;
      window.ReactDOM = { ...ReactDOM, ...ReactDOMClient };
      window.Recharts = Recharts;

      // Try current version first, fall back to last known good version
      let DashboardUIComponents, StackSDK;
      try {
        [DashboardUIComponents, StackSDK] = await Promise.all([
          import('https://esm.sh/@hexclave/dashboard-ui-components@${esmVersion}?deps=react@19.2.3,react-dom@19.2.3'),
          import('https://esm.sh/@hexclave/js@${esmVersion}'),
        ]);
      } catch (e) {
        reportDependencyError('[sandbox] Custom dashboard packages failed at version ${esmVersion}; trying fallback ${esmFallbackVersion}: ' + formatDependencyError(e), e);
        try {
          [DashboardUIComponents, StackSDK] = await Promise.all([
            import('https://esm.sh/@hexclave/dashboard-ui-components@${esmFallbackVersion}?deps=react@19.2.3,react-dom@19.2.3'),
            import('https://esm.sh/@hexclave/js@${esmFallbackVersion}'),
          ]);
        } catch (e2) {
          failDependencyLoad('[sandbox] Custom dashboard package fallback failed at version ${esmFallbackVersion}: ' + formatDependencyError(e2), e2);
        }
      }

      if (!window.__depsError) {
        window.DashboardUI = DashboardUIComponents;
        window.StackAdminApp = StackSDK.StackAdminApp;
        window.StackServerApp = StackSDK.StackServerApp;
        window.StackSDK = StackSDK;
        window.generateUuid = () => crypto.randomUUID();

        window.__depsReady = true;
        window.dispatchEvent(new Event('deps-ready'));
      }
    </script>`;
}

function encodeSourceForJsonScript(code: string): string {
  return JSON.stringify(code).replace(/</g, "\\u003c");
}

function getSandboxDocument(artifact: DashboardArtifact, baseUrl: string, dashboardUrl: string, initialTheme: "light" | "dark", showControls: boolean, initialChatOpen: boolean): string {
  const encodedSource = encodeSourceForJsonScript(artifact.runtimeCodegen.uiRuntimeSourceCode);
  const darkClass = initialTheme === "dark" ? "dark" : "";
  const esmVersion = extractEsmVersion(artifact.runtimeCodegen.uiRuntimeSourceCode) ?? packageJson.version;
  const esmFallbackVersion = getEsmFallbackVersion(esmVersion);
  const devScriptSrc = isDev ? ` ${dashboardUrl}` : '';
  const devConnectSrc = isDev ? ` ${dashboardUrl}` : '';

  return html`<!doctype html>
<html class="${darkClass}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://esm.sh https://js.stripe.com${devScriptSrc}; style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src data: https:; connect-src ${baseUrl} https://unpkg.com https://cdn.jsdelivr.net https://esm.sh https://api.stripe.com https://m.stripe.com https://m.stripe.network${devConnectSrc}; font-src 'none'; frame-src https://js.stripe.com https://hooks.stripe.com https://m.stripe.network; worker-src 'none';" />
    
    <!-- Tailwind CSS Play CDN (for on-the-fly processing) -->
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            colors: {
              border: 'hsl(var(--border))',
              input: 'hsl(var(--input))',
              ring: 'hsl(var(--ring))',
              background: 'hsl(var(--background))',
              foreground: 'hsl(var(--foreground))',
              primary: {
                DEFAULT: 'hsl(var(--primary))',
                foreground: 'hsl(var(--primary-foreground))',
              },
              secondary: {
                DEFAULT: 'hsl(var(--secondary))',
                foreground: 'hsl(var(--secondary-foreground))',
              },
              destructive: {
                DEFAULT: 'hsl(var(--destructive))',
                foreground: 'hsl(var(--destructive-foreground))',
              },
              muted: {
                DEFAULT: 'hsl(var(--muted))',
                foreground: 'hsl(var(--muted-foreground))',
              },
              accent: {
                DEFAULT: 'hsl(var(--accent))',
                foreground: 'hsl(var(--accent-foreground))',
              },
              card: {
                DEFAULT: 'hsl(var(--card))',
                foreground: 'hsl(var(--card-foreground))',
              },
            },
          }
        }
      }
    </script>
    
    <style>
      :root {
        --background: 0 0% 100%;
        --foreground: 240 10% 3.9%;
        --card: 0 0% 100%;
        --card-foreground: 240 10% 3.9%;
        --primary: 240 5.9% 10%;
        --primary-foreground: 0 0% 98%;
        --secondary: 240 4.8% 95.9%;
        --secondary-foreground: 240 5.9% 10%;
        --muted: 240 4.8% 95.9%;
        --muted-foreground: 240 3.8% 46.1%;
        --accent: 240 4.8% 95.9%;
        --accent-foreground: 240 5.9% 10%;
        --destructive: 0 84.2% 60.2%;
        --destructive-foreground: 0 0% 98%;
        --border: 240 5.9% 90%;
        --input: 240 5.9% 90%;
        --ring: 240 10% 3.9%;
      }
      .dark {
        --background: 240 10% 3.9%;
        --foreground: 0 0% 98%;
        --card: 240 10% 9.4%;
        --card-foreground: 0 0% 98%;
        --primary: 0 0% 98%;
        --primary-foreground: 240 5.9% 10%;
        --secondary: 240 3.7% 15.9%;
        --secondary-foreground: 0 0% 98%;
        --muted: 240 3.7% 15.9%;
        --muted-foreground: 240 5% 64.9%;
        --accent: 240 3.7% 15.9%;
        --accent-foreground: 0 0% 98%;
        --destructive: 0 62.8% 50%;
        --destructive-foreground: 0 0% 98%;
        --border: 240 3.7% 35.9%;
        --input: 240 3.7% 25.9%;
        --ring: 240 4.9% 83.9%;
      }
      :root, .dark { --page-background: transparent; }
      html {
        width: 100%;
        height: 100%;
        overflow-x: hidden;
      }
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-height: 100%;
        overflow-x: hidden;
        font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif;
        background: var(--page-background);
        color: hsl(var(--foreground));
        /* Flex column so #root fills remaining height when content is short, and
           the add-component button (last body child) sits naturally at the bottom
           of the scrollable region when content is tall. Without flex, #root's
           height:100% would push the button below the viewport unreachable. */
        display: flex;
        flex-direction: column;
      }
      #root {
        width: 100%;
        overflow-x: hidden;
        flex: 1 0 auto;
        min-height: 0;
      }
      * { box-sizing: border-box; }
      .dark { color-scheme: dark; }
      html, body, #root { scrollbar-width: none; }
      html::-webkit-scrollbar, body::-webkit-scrollbar, #root::-webkit-scrollbar { display: none; }

      /* Widget selection overlay — active only when chat panel is open */
      .widget-overlay {
        position: fixed;
        pointer-events: none;
        border: 2px dashed hsl(var(--primary) / 0.35);
        border-radius: 10px;
        z-index: 9999;
        transition: top 0.12s ease, left 0.12s ease, width 0.12s ease, height 0.12s ease;
        display: none;
        background: hsl(var(--primary) / 0.03);
      }
      .widget-overlay-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        pointer-events: auto;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.15s ease, transform 0.15s ease;
        box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      }
      .widget-overlay-btn:hover { transform: scale(1.08); }
      .widget-overlay.active .widget-overlay-btn { opacity: 1; }

      /* "Add a component" affordance — sits at the bottom of the dashboard content,
         inside the iframe so it scrolls naturally with the page (NOT sticky). Dashed
         border matches the widget overlay so it reads as part of the same editor
         language. Visible only in edit mode (chat open) — toggled via
         window.__chatOpen. */
      .add-component-btn {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        flex-shrink: 0;
        width: calc(100% - 48px);
        max-width: calc(80rem - 48px);
        margin: 16px auto 12px;
        padding: 14px 16px;
        background: transparent;
        border: 2px dashed hsl(var(--primary) / 0.35);
        border-radius: 12px;
        color: hsl(var(--muted-foreground));
        font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
      }
      .add-component-btn.visible { display: flex; }
      .add-component-btn:hover {
        border-color: hsl(var(--primary) / 0.6);
        color: hsl(var(--primary));
        background: hsl(var(--primary) / 0.04);
      }
      .add-component-btn .plus-icon { width: 16px; height: 16px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="https://unpkg.com/@babel/standalone@7.29.7/babel.min.js" crossorigin="anonymous"></script>

    <!-- Install a global error listener BEFORE any AI code runs so that Babel parse
         errors, uncaught runtime throws, and async rejections all reach the parent.
         Without this, a JSX SyntaxError in the AI-generated code would surface only
         as a console error and the user would see a blank iframe. -->
    <script>
      (function () {
        function postError(message, stack) {
          try {
            window.parent.postMessage({
              type: 'dashboard-error-boundary',
              message: message || 'Unknown dashboard error',
              stack: stack || undefined,
            }, '*');
          } catch (_) { /* parent may be gone */ }
        }
        window.__postDashboardError = postError;
        window.addEventListener('error', function (event) {
          var err = event && event.error;
          postError((err && err.message) || (event && event.message) || 'Unknown runtime error', err && err.stack);
        });
        window.addEventListener('unhandledrejection', function (event) {
          var reason = event && event.reason;
          postError((reason && (reason.message || String(reason))) || 'Unhandled promise rejection', reason && reason.stack);
        });
      })();
    </script>

    ${getDependencyScripts(esmVersion, esmFallbackVersion, dashboardUrl)}

    <script type="application/json" id="ai-dashboard-source">${encodedSource}</script>

    <script type="text/babel">
      // Navigation API for AI-generated code
      window.dashboardNavigate = function(path) {
        window.parent.postMessage({ type: 'dashboard-navigate', path: path }, '*');
      };
      window.dashboardBack = function() {
        window.parent.postMessage({ type: 'dashboard-back' }, '*');
      };
      window.dashboardEdit = function() {
        window.parent.postMessage({ type: 'dashboard-edit' }, '*');
      };
      // Controls visibility flag — only true in the full dashboard viewer (not cmd+K preview)
      window.__showControls = ${showControls};
      window.__chatOpen = ${initialChatOpen};
      // Inline <script> tags earlier in <body> (widget overlay, add-component button) run
      // synchronously as the parser hits them — BEFORE this text/babel block runs on
      // DOMContentLoaded. Those scripts install listeners for 'chat-state-change' and
      // call their syncVisibility() once at install time, where window.__chatOpen is
      // still undefined. Re-dispatch the event now so they pick up the real flag and
      // show/hide themselves correctly on first mount.
      window.dispatchEvent(new Event('chat-state-change'));

      // Theme syncing and chat state from parent window
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'stack-theme-change') {
          const theme = event.data.theme;
          if (theme === 'dark') {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        }
        if (event.data?.type === 'dashboard-controls-update') {
          window.__chatOpen = !!event.data.chatOpen;
          window.dispatchEvent(new Event('chat-state-change'));
        }
      });

      const STACK_CONFIG = {
        baseUrl: ${JSON.stringify(baseUrl)},
        projectId: ${JSON.stringify(artifact.projectId)},
      };

      async function waitForDeps() {
        if (!window.__depsReady) {
          await new Promise(resolve => {
            window.addEventListener('deps-ready', resolve, { once: true });
          });
        }
        if (window.__depsError) {
          const error = new Error(window.__depsError.message || 'There was a problem loading custom dashboards. Please refresh the page and try again.');
          if (window.__depsError.stack) {
            error.stack = window.__depsError.stack;
          }
          throw error;
        }
      }

      async function requestAccessToken() {
        return new Promise((resolve, reject) => {
          const requestId = window.generateUuid();
          const timeout = setTimeout(() => {
            window.removeEventListener('message', handler);
            reject(new Error('Token request timeout'));
          }, 5000);

          const handler = (event) => {
            if (event.data?.type === 'stack-access-token-response' && event.data?.requestId === requestId) {
              clearTimeout(timeout);
              window.removeEventListener('message', handler);

              if (event.data.accessToken) {
                resolve(event.data.accessToken);
              } else {
                reject(new Error('No access token received from parent'));
              }
            }
          };

          window.addEventListener('message', handler);
          window.parent.postMessage({
            type: 'stack-access-token-request',
            requestId
          }, '*');
        });
      }

      async function initializeStackApp() {
        await waitForDeps();

        if (!window.StackAdminApp) {
          throw new Error("Stack SDK failed to load. The SDK should expose window.StackAdminApp.");
        }

        const hexclaveServerApp = new window.StackAdminApp({
          projectId: STACK_CONFIG.projectId,
          baseUrl: STACK_CONFIG.baseUrl,
          projectOwnerSession: async () => {
            return await requestAccessToken();
          },
          automaticSideEffects: false,
          analytics: { enabled: false },
        });

        // Expose under both names. AI-generated dashboards (post-PR2 prompt)
        // reference hexclaveServerApp; pre-rebrand saved dashboards still
        // reference stackServerApp. Both must resolve at runtime.
        window.hexclaveServerApp = hexclaveServerApp;
        window.stackServerApp = hexclaveServerApp;

        return hexclaveServerApp;
      }

      // Uncaught runtime errors and unhandled rejections are forwarded by the
      // early global listener installed before Babel loads (see top of <head>).

      // Error Boundary Component
      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { hasError: false, error: null };
        }

        static getDerivedStateFromError(error) {
          return { hasError: true, error };
        }

        componentDidCatch(error, errorInfo) {
          window.parent.postMessage({
            type: 'dashboard-error-boundary',
            message: error?.message,
            stack: error?.stack,
            componentStack: errorInfo?.componentStack,
          }, '*');
        }

        render() {
          if (this.state.hasError) {
            return (
              <div className="p-6 text-red-500" data-stack-no-widget="true">
                <h2 className="text-xl font-bold mb-2">Dashboard Error</h2>
                <pre className="text-sm bg-red-950/20 p-4 rounded overflow-auto">
                  {this.state.error?.message || 'Unknown error'}
                </pre>
                {this.state.error?.stack && (
                  <pre className="text-xs bg-red-950/10 p-4 rounded overflow-auto mt-2">
                    {this.state.error.stack}
                  </pre>
                )}
              </div>
            );
          }
          return this.props.children;
        }
      }

      // Boot the dashboard
      const rootElement = document.getElementById('root');
      if (!rootElement) {
        throw new Error('Root element not found');
      }

      // Initialize deps and boot the dashboard
      initializeStackApp().then(() => {
        const DashboardUI = window.DashboardUI;
        const Recharts = window.Recharts;

        if (!DashboardUI) {
          throw new Error("Dashboard UI components failed to load in sandbox.");
        }
        if (!Recharts) {
          throw new Error("Recharts failed to load in sandbox.");
        }

        // Execute AI-generated code with DashboardUI and Recharts in scope.
        // We compile here (rather than via <script type="text/babel">) so that
        // a JSX SyntaxError in the AI output surfaces as a normal throw — the
        // window 'error' listener picks it up and forwards it to the parent
        // composer instead of leaving the iframe blank.
        const aiSourceEl = document.getElementById('ai-dashboard-source');
        if (!aiSourceEl || !aiSourceEl.textContent) {
          throw new Error('Failed to parse aiSource from aiSourceEl: #ai-dashboard-source script tag is missing or empty');
        }
        let aiSource;
        try {
          aiSource = JSON.parse(aiSourceEl.textContent);
        } catch (parseErr) {
          const original = parseErr && parseErr.message ? parseErr.message : String(parseErr);
          const preview = aiSourceEl.textContent.slice(0, 500);
          const wrapped = new Error('Failed to parse aiSource from aiSourceEl: ' + original + ' | textContent preview: ' + preview);
          if (parseErr && parseErr.stack) wrapped.stack = parseErr.stack;
          throw wrapped;
        }
        if (typeof aiSource !== 'string') {
          throw new Error('Failed to parse aiSource from aiSourceEl: expected JSON-encoded string, got ' + typeof aiSource);
        }
        let compiledSource;
        try {
          compiledSource = window.Babel.transform(aiSource, { presets: ['react'], sourceType: 'script' }).code;
        } catch (err) {
          const message = err && err.message ? 'Dashboard code failed to compile: ' + err.message : 'Dashboard code failed to compile';
          const stack = err && err.stack ? err.stack : undefined;
          window.__postDashboardError && window.__postDashboardError(message, stack);
          const root = ReactDOM.createRoot(rootElement);
          root.render(
            <div className="p-6 text-red-500">
              <h2 className="text-xl font-bold mb-2">Dashboard failed to compile</h2>
              <pre className="text-sm bg-red-950/20 p-4 rounded overflow-auto whitespace-pre-wrap">
                {message}
              </pre>
            </div>
          );
          return;
        }
        // eslint-disable-next-line no-new-func
        const Dashboard = new Function('React', 'ReactDOM', 'DashboardUI', 'Recharts', 'hexclaveServerApp', compiledSource + '\\nreturn Dashboard;')(
          React, ReactDOM, DashboardUI, Recharts, window.hexclaveServerApp,
        );


        if (typeof Dashboard !== 'function') {
          throw new Error('Dashboard component not found in generated code');
        }

        const root = ReactDOM.createRoot(rootElement);
        root.render(
          <ErrorBoundary>
            <Dashboard />
          </ErrorBoundary>
        );

        parent.postMessage({ type: "stack-ai-dashboard-ready" }, "*");
      }).catch(error => {
        const message = error instanceof Error ? error.message : "Failed to initialize dashboard";
        parent.postMessage({
          type: "stack-ai-dashboard-error",
          message: message,
          stack: error instanceof Error ? error.stack : undefined,
        }, "*");
        
        const root = ReactDOM.createRoot(rootElement);
        root.render(
          <div className="p-6 text-red-500" data-stack-no-widget="true">
            <h2 className="text-xl font-bold mb-2">Failed to load dashboard</h2>
            <pre className="text-sm bg-red-950/20 p-4 rounded">
              {message}
            </pre>
          </div>
        );
      });
    </script>

    <!-- Widget selection overlay — lets the user pick a widget and send it to the chat panel -->
    <script>
    (function () {
      var overlay = document.createElement('div');
      overlay.className = 'widget-overlay';
      var btn = document.createElement('button');
      btn.className = 'widget-overlay-btn';
      btn.setAttribute('aria-label', 'Add to chat');
      btn.title = 'Add to chat';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M216,48H40A16,16,0,0,0,24,64V176a16,16,0,0,0,16,16H96l32,32a8,8,0,0,0,11.31,0L171.31,192H216a16,16,0,0,0,16-16V64A16,16,0,0,0,216,48ZM160,136H96a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Zm0-32H96a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Z"/></svg>';
      overlay.appendChild(btn);

      var currentWidget = null;
      var mounted = false;

      function mount() {
        if (mounted) return;
        document.body.appendChild(overlay);
        mounted = true;
      }

      /* ── Widget detection heuristic ── */
      function findWidget(el) {
        var current = el;
        var root = document.getElementById('root');
        // Error screens (ErrorBoundary fallback, init-failure UI) are marked with
        // data-stack-no-widget so the user can't "chip" an error widget — that would
        // just round-trip the rendered error text back to the AI, which is useless.
        if (el && typeof el.closest === 'function' && el.closest('[data-stack-no-widget]')) {
          return null;
        }
        while (current && current !== root && current !== document.body) {
          if (current === overlay || overlay.contains(current)) {
            current = current.parentElement;
            continue;
          }
          if (current.hasAttribute && current.hasAttribute('data-stack-no-widget')) {
            return null;
          }
          var rect = current.getBoundingClientRect();
          if (rect.width < 80 || rect.height < 50) { current = current.parentElement; continue; }
          if (rect.width > window.innerWidth * 0.85 && rect.height > window.innerHeight * 0.85) {
            current = current.parentElement; continue;
          }
          var hasContent = current.querySelector('svg, h1, h2, h3, h4, h5, h6, table, img, canvas');
          var cls = typeof current.className === 'string' ? current.className : '';
          var isCard = /rounded|shadow|border|card|bg-/.test(cls);
          var parent = current.parentElement;
          var isLayoutChild = false;
          if (parent && parent !== root) {
            var ps = getComputedStyle(parent).display;
            isLayoutChild = ps === 'grid' || ps === 'flex';
          }
          if (hasContent || isCard || isLayoutChild) return current;
          current = current.parentElement;
        }
        return null;
      }

      function showOverlay(widget) {
        mount();
        var rect = widget.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.style.top = rect.top - 2 + 'px';
        overlay.style.left = rect.left - 2 + 'px';
        overlay.style.width = rect.width + 4 + 'px';
        overlay.style.height = rect.height + 4 + 'px';
        overlay.classList.add('active');
        currentWidget = widget;
      }

      function hideOverlay() {
        overlay.style.display = 'none';
        overlay.classList.remove('active');
        currentWidget = null;
      }

      var lastCursor = null;

      document.addEventListener('mousemove', function (e) {
        lastCursor = { x: e.clientX, y: e.clientY };
        if (!window.__chatOpen) return;
        if (overlay.contains(e.target)) return;
        var widget = findWidget(e.target);
        if (widget && widget !== currentWidget) showOverlay(widget);
        else if (!widget) hideOverlay();
      });

      /* Scroll doesn't fire mousemove, so without this the overlay stays pinned at
         the old viewport coordinates while the widget underneath scrolls away. Use
         elementFromPoint at the cursor's last known position to figure out what's
         actually under the cursor now and re-target or hide accordingly. Captured
         on scroll with passive:true so it doesn't slow scrolling. */
      function reevaluateFromScroll() {
        if (!window.__chatOpen) { hideOverlay(); return; }
        if (!lastCursor) { hideOverlay(); return; }
        var el = document.elementFromPoint(lastCursor.x, lastCursor.y);
        if (!el || overlay.contains(el)) return;
        var widget = findWidget(el);
        if (widget) showOverlay(widget);
        else hideOverlay();
      }
      window.addEventListener('scroll', reevaluateFromScroll, { passive: true, capture: true });

      document.addEventListener('mouseleave', function () { hideOverlay(); });
      window.addEventListener('chat-state-change', function () { if (!window.__chatOpen) hideOverlay(); });

      /* Build a CSS-ish selector path from #root down to the widget, capped at 10
         segments so it stays AI-digestible. Each segment is the tag plus the first
         className token (if any), plus a nth-of-type suffix only when the parent has
         sibling tags of the same name. The path lets the AI ground the patch on a
         real chunk of structure rather than inferring from heading text alone. */
      function buildSelectorPath(el) {
        var rootEl = document.getElementById('root');
        var segments = [];
        var node = el;
        while (node && node !== rootEl && node !== document.body && segments.length < 10) {
          var tag = node.tagName.toLowerCase();
          var classToken = '';
          if (typeof node.className === 'string') {
            var firstClass = node.className.trim().split(/\s+/)[0];
            if (firstClass && !/^widget-overlay/.test(firstClass)) {
              classToken = '.' + firstClass;
            }
          }
          var nthSelector = '';
          var parent = node.parentElement;
          if (parent) {
            var sameTagSiblings = [];
            for (var i = 0; i < parent.children.length; i++) {
              if (parent.children[i].tagName === node.tagName) {
                sameTagSiblings.push(parent.children[i]);
              }
            }
            if (sameTagSiblings.length > 1) {
              var idx = sameTagSiblings.indexOf(node) + 1;
              nthSelector = ':nth-of-type(' + idx + ')';
            }
          }
          segments.unshift(tag + classToken + nthSelector);
          node = node.parentElement;
        }
        return segments.join(' > ');
      }

      /* ── Send DOM metadata to parent ── */
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (!currentWidget) return;

        var heading = currentWidget.querySelector('h1,h2,h3,h4,h5,h6')
          || currentWidget.querySelector('span.font-semibold');
        var widgetRect = currentWidget.getBoundingClientRect();
        var outerHTML = '';
        try { outerHTML = (currentWidget.outerHTML || '').slice(0, 300); } catch (_) {}
        var metadata = {
          heading: heading ? heading.textContent.trim() : null,
          tagName: currentWidget.tagName.toLowerCase(),
          classes: (typeof currentWidget.className === 'string' ? currentWidget.className : '').slice(0, 300),
          textPreview: (currentWidget.textContent || '').trim().slice(0, 500),
          rect: { width: Math.round(widgetRect.width), height: Math.round(widgetRect.height) },
          selectorPath: buildSelectorPath(currentWidget),
          outerHTMLSnippet: outerHTML,
        };

        window.parent.postMessage({ type: 'dashboard-widget-selected', metadata: metadata }, '*');
        hideOverlay();
      });
    })();
    </script>

    <!-- "Add a component" button — appended as a sibling of #root so it sits at the
         bottom of the dashboard content and scrolls into view (NOT sticky/fixed).
         Visibility tracks window.__chatOpen so it only appears in edit mode. -->
    <script>
    (function () {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'add-component-btn';
      btn.innerHTML = '<svg class="plus-icon" viewBox="0 0 256 256" fill="currentColor"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg><span>Add a component</span>';
      function syncVisibility() {
        if (window.__chatOpen) btn.classList.add('visible');
        else btn.classList.remove('visible');
      }
      btn.addEventListener('click', function () {
        window.parent.postMessage({ type: 'dashboard-add-component-clicked' }, '*');
      });
      document.body.appendChild(btn);
      syncVisibility();
      window.addEventListener('chat-state-change', syncVisibility);
    })();
    </script>
  </body>
</html>`;
}

/**
 * Shape of a runtime error surfaced from the sandbox iframe. Covers three sources:
 *   1. React ErrorBoundary catches (componentStack is present)
 *   2. Uncaught window errors (sync throws outside render)
 *   3. Unhandled promise rejections (async failures inside effects/handlers)
 */
export type DashboardRuntimeError = {
  message: string,
  stack?: string,
  componentStack?: string,
};

/**
 * Payload sent when the user clicks "Add to chat" on a widget in the iframe.
 * `metadata` carries DOM info so the AI knows which part of the dashboard is targeted.
 */
export type WidgetSelection = {
  metadata: {
    heading: string | null,
    tagName: string,
    classes: string,
    textPreview: string,
    rect: { width: number, height: number },
    /** CSS-style selector chain from #root down to the clicked widget. Capped at 10
        segments. Lets the AI ground a patch on a real chunk of structure. */
    selectorPath: string,
    /** First ~300 chars of the widget's outerHTML — verbatim rendered markup the AI
        can match against when locating the JSX node in source. */
    outerHTMLSnippet: string,
  },
};

export const DashboardSandboxHost = memo(function DashboardSandboxHost({
  artifact,
  onBack,
  onEditToggle,
  onNavigate,
  onReady,
  onRuntimeError,
  onWidgetSelected,
  onAddComponentClicked,
  isChatOpen,
}: {
  artifact: DashboardArtifact,
  onBack?: () => void,
  onEditToggle?: () => void,
  onNavigate?: (path: string) => void,
  onReady?: () => void,
  /** Fires whenever the sandbox reports a runtime error. Parent uses this to auto-insert
      the crash into the assistant composer so the user can one-click fix it. */
  onRuntimeError?: (err: DashboardRuntimeError) => void,
  /** Fires when the user clicks "Add to chat" on a widget overlay in the iframe. */
  onWidgetSelected?: (selection: WidgetSelection) => void,
  /** Fires when the user clicks the in-iframe "Add a component" button at the bottom
      of the dashboard. Parent pushes an action chip into the composer chip bar. */
  onAddComponentClicked?: () => void,
  isChatOpen?: boolean,
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onEditToggleRef = useRef(onEditToggle);
  onEditToggleRef.current = onEditToggle;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onRuntimeErrorRef = useRef(onRuntimeError);
  onRuntimeErrorRef.current = onRuntimeError;
  const onWidgetSelectedRef = useRef(onWidgetSelected);
  onWidgetSelectedRef.current = onWidgetSelected;
  const onAddComponentClickedRef = useRef(onAddComponentClicked);
  onAddComponentClickedRef.current = onAddComponentClicked;
  const user = useDashboardUser();
  const { resolvedTheme } = useTheme();

  const baseUrl = useMemo(() => {
    const url = getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL");
    if (!url) throw new Error("NEXT_PUBLIC_STACK_API_URL is not set");
    return url;
  }, []);

  const dashboardUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);

  const initialThemeRef = useRef<"light" | "dark">(resolvedTheme === "dark" ? "dark" : "light");
  const initialChatOpenRef = useRef(!!isChatOpen);
  const showControls = onBack != null || onEditToggle != null;
  const srcDoc = useMemo(() => getSandboxDocument(artifact, baseUrl, dashboardUrl, initialThemeRef.current, showControls, initialChatOpenRef.current), [artifact, baseUrl, dashboardUrl, showControls]);

  // Send theme changes to iframe dynamically (without full reload)
  useEffect(() => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'stack-theme-change',
        theme: resolvedTheme,
      }, '*');
    }
  }, [resolvedTheme]);

  useEffect(() => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'dashboard-controls-update',
        chatOpen: !!isChatOpen,
      }, '*');
    }
  }, [isChatOpen]);


  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "object" || event.data === null) {
        return;
      }
      if (event.origin !== "null") {
        return;
      }
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const type = event.data.type;

      if (type === "stack-access-token-request") {
        const requestId = event.data.requestId;
        runAsynchronously(async () => {
          const accessToken = await user.getAccessToken();
          if (!accessToken) {
            const err = new Error('[DashboardSandboxHost] Failed to get access token: access token is null');
            captureError('dashboard-sandbox-host', err);
            event.source?.postMessage({
              type: 'stack-access-token-response',
              requestId,
              accessToken: null,
              error: err.message,
            }, { targetOrigin: '*' });
            return;
          }

          event.source?.postMessage({
            type: 'stack-access-token-response',
            requestId,
            accessToken,
          }, { targetOrigin: '*' });
        });
        return;
      }

      if (type === "dashboard-navigate") {
        onNavigateRef.current?.(event.data.path);
        return;
      }

      if (type === "dashboard-back") {
        onBackRef.current?.();
        return;
      }

      if (type === "dashboard-edit") {
        onEditToggleRef.current?.();
        return;
      }

      if (type === "dashboard-sandbox-dependency-error") {
        const err = new Error(event.data.message ?? 'Unknown custom dashboard dependency error');
        if (event.data.stack) err.stack = event.data.stack;
        captureError('dashboard-sandbox-dependency-error', err);
        return;
      }

      if (type === "dashboard-error-boundary") {
        const err = new Error(event.data.message ?? 'Unknown dashboard error');
        if (event.data.stack) err.stack = event.data.stack;
        captureError('dashboard-sandbox-error-boundary', err);
        onRuntimeErrorRef.current?.({
          message: typeof event.data.message === "string" ? event.data.message : "Unknown dashboard error",
          stack: typeof event.data.stack === "string" ? event.data.stack : undefined,
          componentStack: typeof event.data.componentStack === "string" ? event.data.componentStack : undefined,
        });
        return;
      }

      if (type === "stack-ai-dashboard-error") {
        // Thrown during sandbox initialization (deps failed to load, Dashboard export missing, etc.)
        // Surface it via the same channel so the UX is consistent with runtime errors.
        onRuntimeErrorRef.current?.({
          message: typeof event.data.message === "string" ? event.data.message : "Failed to initialize dashboard",
          stack: typeof event.data.stack === "string" ? event.data.stack : undefined,
        });
        return;
      }

      if (type === "dashboard-widget-selected") {
        onWidgetSelectedRef.current?.({
          metadata: {
            heading: typeof event.data.metadata?.heading === "string" ? event.data.metadata.heading : null,
            tagName: typeof event.data.metadata?.tagName === "string" ? event.data.metadata.tagName : "div",
            classes: typeof event.data.metadata?.classes === "string" ? event.data.metadata.classes : "",
            textPreview: typeof event.data.metadata?.textPreview === "string" ? event.data.metadata.textPreview : "",
            rect: {
              width: typeof event.data.metadata?.rect?.width === "number" ? event.data.metadata.rect.width : 0,
              height: typeof event.data.metadata?.rect?.height === "number" ? event.data.metadata.rect.height : 0,
            },
            selectorPath: typeof event.data.metadata?.selectorPath === "string" ? event.data.metadata.selectorPath : "",
            outerHTMLSnippet: typeof event.data.metadata?.outerHTMLSnippet === "string" ? event.data.metadata.outerHTMLSnippet : "",
          },
        });
        return;
      }

      if (type === "dashboard-add-component-clicked") {
        onAddComponentClickedRef.current?.();
        return;
      }

      if (type === "stack-ai-dashboard-ready") {
        onReadyRef.current?.();
        return;
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [user]);

  return (
    <iframe
      ref={iframeRef}
      title="AI Dashboard Preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="h-full w-full bg-transparent"

    />
  );
});
