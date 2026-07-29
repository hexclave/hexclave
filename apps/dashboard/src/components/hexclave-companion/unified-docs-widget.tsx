'use client';

import { ArrowLeftIcon, BookOpenIcon, ArrowSquareOutIcon, CircleNotchIcon } from '@phosphor-icons/react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getPublicEnvVar } from '../../lib/env';

type UnifiedDocsWidgetProps = {
  isActive: boolean,
};

type DocContent = {
  title: string,
  url: string,
  type: 'dashboard' | 'docs' | 'api',
};

type DocType = 'dashboard' | 'docs' | 'api';

const PROD_DOCS_ORIGIN = 'https://docs.hexclave.com';

const isLocalHostname = (hostname: string): boolean => {
  return hostname === 'localhost' || hostname === '127.0.0.1';
};

const isAllowedDocsUrl = (url: URL): boolean => {
  if (isLocalHostname(url.hostname)) {
    // Permit localhost/127.0.0.1 for local development regardless of port
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'docs.hexclave.com') return true;
  // Accept both .hexclave.com (canonical) and .stack-auth.com (legacy, for the
  // dual-resolving transition window before DNS for *.hexclave.com is live).
  return hostname.endsWith('.hexclave.com') || hostname.endsWith('.stack-auth.com');
};

const isLocalEnvironment = (): boolean => {
  if (typeof window !== 'undefined') {
    return isLocalHostname(window.location.hostname);
  }

  return process.env.NODE_ENV === 'development';
};

// Get the docs base URL from environment variable with fallback
const getDocsBaseUrl = (): string => {
  const fallbackOrigin = isLocalEnvironment()
    ? `http://localhost:${getPublicEnvVar('NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX') ?? '81'}04`
    : PROD_DOCS_ORIGIN;

  // Use centralized environment variable system
  const docsBaseUrl = getPublicEnvVar('NEXT_PUBLIC_STACK_DOCS_BASE_URL');
  if (docsBaseUrl) {
    try {
      const parsedUrl = new URL(docsBaseUrl);

      if (isAllowedDocsUrl(parsedUrl)) {
        return parsedUrl.origin;
      }

      console.warn(
        '[UnifiedDocsWidget] Ignoring untrusted docs base URL from env:',
        parsedUrl.origin
      );
    } catch (error) {
      console.warn('[UnifiedDocsWidget] Invalid docs base URL provided via env:', error);
    }
  }

  // Fallback logic for when env var is not set
  return fallbackOrigin;
};

// Route patterns for matching dashboard pages
const DASHBOARD_ROUTE_PATTERNS = [
  // Main dashboard routes (match your actual dashboard URLs)
  // Users
  { pattern: /\/users(?:\/.*)?$/, docPage: 'users' },
  { pattern: /\/app-configuration\/authentication(?:\/.*)?$/, docPage: 'auth-methods' },
  { pattern: /\/project-settings\/oauth(?:\/.*)?$/, docPage: 'auth-methods' },
  { pattern: /\/auth-methods(?:\/.*)?$/, docPage: 'auth-methods' },

  // Teams
  { pattern: /\/teams(?:\/.*)?$/, docPage: 'orgs-and-teams' },
  { pattern: /\/team-permissions(?:\/.*)?$/, docPage: 'team-permissions' },

  // Emails
  { pattern: /\/emails(?:\/.*)?$/, docPage: 'emails' },

  // Payments
  // TODO: Add Docs for payments here

  // Configuration
  { pattern: /\/project-settings\/domains(?:\/.*)?$/, docPage: 'domains' },
  { pattern: /\/domains(?:\/.*)?$/, docPage: 'domains' },
  { pattern: /\/app-configuration(?:\/.*)?$/, docPage: 'project-settings' },
  { pattern: /\/webhooks(?:\/.*)?$/, docPage: 'webhooks' },
  { pattern: /\/api-keys(?:\/.*)?$/, docPage: 'hexclave-keys' },
  { pattern: /\/project-settings(?:\/.*)?$/, docPage: 'project-settings' },
];

// Get the dashboard page name from the current pathname
const getDashboardPage = (path: string): string => {
  // Normalize the path by removing the projects/<projectId> prefix
  const normalizedPath = path.replace(/^\/projects\/[^/]+/, '');

  // Find the first matching pattern
  for (const { pattern, docPage } of DASHBOARD_ROUTE_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return docPage;
    }
  }

  // Default to overview for root dashboard or unmatched routes
  return 'overview';
};

// Get documentation URL and title for the current page and doc type
const DASHBOARD_TO_DOCS_MAP = new Map<string, { path: string, title: string }>([
  ['overview', { path: 'overview', title: 'Hexclave Overview' }],
  ['users', { path: 'getting-started/users', title: 'User Management' }],
  ['auth-methods', { path: 'concepts/auth-providers', title: 'Authentication Providers' }],
  ['orgs-and-teams', { path: 'concepts/orgs-and-teams', title: 'Teams & Organizations' }],
  ['team-permissions', { path: 'concepts/permissions#team-permissions', title: 'Team Permissions' }],
  ['emails', { path: 'concepts/emails', title: 'Emails' }],
  ['domains', { path: 'getting-started/production#domains', title: 'Domains' }],
  ['webhooks', { path: 'concepts/webhooks', title: 'Webhooks' }],
  ['hexclave-keys', { path: 'getting-started/setup#update-api-keys', title: 'Hexclave Keys' }],
  ['project-settings', { path: 'getting-started/production#enabling-production-mode', title: 'Project Configuration' }],
]);

const getDocContentForPath = (path: string, docType: DocType): DocContent => {
  switch (docType) {
    case 'dashboard': {
      const page = getDashboardPage(path);

      const docMapping = DASHBOARD_TO_DOCS_MAP.get(page);
      if (!docMapping) {
        throw new Error(`No documentation mapping found for dashboard page: ${page}`);
      }
      const url = `${getDocsBaseUrl()}/docs-embed/${docMapping.path}`;
      const title = docMapping.title;
      return { title, url, type: 'dashboard' };
    }
    case 'docs': {
      // Default to getting started for main docs
      const url = `${getDocsBaseUrl()}/docs-embed/getting-started/setup`;
      const title = 'Hexclave Documentation';
      return { title, url, type: 'docs' };
    }
    case 'api': {
      // Default to overview for API docs
      const url = `${getDocsBaseUrl()}/api-embed/overview`;
      const title = 'API Reference';
      return { title, url, type: 'api' };
    }
    default: {
      throw new Error(`Unknown doc type: ${docType}`);
    }
  }
};

export function UnifiedDocsWidget({ isActive }: UnifiedDocsWidgetProps) {
  const pathname = usePathname();
  const [selectedDocType, setSelectedDocType] = useState<DocType>('dashboard');
  const [docContent, setDocContent] = useState<DocContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSwitchPrompt, setShowSwitchPrompt] = useState(false);
  const [currentPageDoc, setCurrentPageDoc] = useState<string>('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [iframeRef, setIframeRef] = useState<HTMLIFrameElement | null>(null);

  // Load documentation when the component becomes active, doc type changes, or pathname changes
  useEffect(() => {
    if (isActive) {
      const newPageDoc = getDashboardPage(pathname);

      // If this is the first time opening or doc type changed
      if (!docContent || docContent.type !== selectedDocType) {
        setLoading(true);
        setError(null);
        setCurrentPageDoc(newPageDoc);
        setCanGoBack(false);

        try {
          const page = getDashboardPage(pathname);
          console.log('Debug mapping:', {
            pathname,
            normalizedPath: pathname.replace(/^\/projects\/[^/]+/, ''),
            detectedPage: page
          });
          const content = getDocContentForPath(pathname, selectedDocType);
          console.log('Loading docs:', { page, url: content.url });
          setDocContent(content);
        } catch (err) {
          console.error('Failed to load documentation:', err);
          setError(err instanceof Error ? err.message : 'Failed to load documentation');
          setLoading(false);
        }
      }
      // If we already have content loaded but user switched to a different dashboard page (only relevant for dashboard docs)
      else if (selectedDocType === 'dashboard' && currentPageDoc !== newPageDoc) {
        setShowSwitchPrompt(true);
      }
    }
  }, [isActive, pathname, selectedDocType, docContent, currentPageDoc]);

  // Listen for navigation state updates from the embedded docs iframe
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let expectedOrigin: string | null = null;
    try {
      expectedOrigin = new URL(getDocsBaseUrl()).origin;
    } catch (error) {
      console.debug('Unable to resolve docs origin', error);
    }

    const handleMessage = (event: MessageEvent) => {
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      if (!event.data || typeof event.data !== 'object') return;

      const data = event.data as { type?: unknown, canGoBack?: unknown };
      if (data.type === 'DOCS_HISTORY_STATE' && typeof data.canGoBack === 'boolean') {
        setCanGoBack(data.canGoBack);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Handle iframe load events
  const handleIframeLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    setLoading(false);
    setError(null);
    setIframeRef(event.currentTarget);
  };

  const handleIframeError = () => {
    setError('Failed to load documentation');
    setLoading(false);
    setCanGoBack(false);
  };

  // Handle switching to current page's documentation
  const handleSwitchToDocs = () => {
    const newPageDoc = getDashboardPage(pathname);
    setLoading(true);
    setError(null);
    setCurrentPageDoc(newPageDoc);
    setShowSwitchPrompt(false);
    setCanGoBack(false);

    try {
      const content = getDocContentForPath(pathname, selectedDocType);
      setDocContent(content);
    } catch (err) {
      console.error('Failed to load documentation:', err);
      setError(err instanceof Error ? err.message : 'Failed to load documentation');
      setLoading(false);
    }
  };

  // Handle dismissing the switch prompt
  const handleDismissSwitch = () => {
    setShowSwitchPrompt(false);
  };

  // Handle back button click
  const handleGoBack = () => {
    if (!iframeRef?.contentWindow) {
      setCanGoBack(false);
      return;
    }

    setCanGoBack(false);

    try {
      const src = iframeRef.getAttribute('src') ?? docContent?.url ?? getDocsBaseUrl();
      const targetOrigin = new URL(src, window.location.href).origin;
      iframeRef.contentWindow.postMessage(
        { type: 'NAVIGATE_BACK' },
        targetOrigin
      );
    } catch (error) {
      console.warn('Failed to request docs back navigation', error);
    }
  };


  if (!isActive) return null;

  return (
    <div className="flex flex-col h-full">

      {/* Switch Prompt for Dashboard Docs */}
      {showSwitchPrompt && selectedDocType === 'dashboard' && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-3">
          <div className="text-blue-800 dark:text-blue-200 text-xs">
            <strong>Page changed:</strong> Switch to docs for this page?
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleSwitchToDocs}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded"
            >
              Switch
            </button>
            <button
              onClick={handleDismissSwitch}
              className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              Keep current
            </button>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-3">
          <div className="flex items-start gap-2">
            <div className="text-red-600 dark:text-red-400 text-xs">
              <strong>Failed to load docs:</strong> {error}
            </div>
          </div>
          <button
            onClick={() => {
              setLoading(true);
              setError(null);
              setCanGoBack(false);
              try {
                const content = getDocContentForPath(pathname, selectedDocType);
                setDocContent(content);
              } catch (err) {
                console.error('Retry failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load documentation');
                setLoading(false);
              }
            }}
            className="mt-2 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Content - Iframe */}
      {docContent && !error && (
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Loading Overlay */}
          {loading && (
            <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-10">
              <div className="flex flex-col items-center gap-2">
                <CircleNotchIcon className="h-6 w-6 animate-spin text-muted-foreground" />
                <div className="text-xs text-muted-foreground">Loading documentation...</div>
              </div>
            </div>
          )}

          {/* Header with controls */}
          <div className="pb-2 mb-3 border-b space-y-2">
            {/* Top row: back button, title, external link */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGoBack}
                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Go back to previous page"
                  disabled={!canGoBack}
                >
                  <ArrowLeftIcon className="h-3 w-3" />
                  <span>Back</span>
                </button>
                <BookOpenIcon className="h-3 w-3 text-muted-foreground" />
                <h4 className="text-xs font-medium text-muted-foreground">{docContent.title}</h4>
              </div>
              <a
                href={docContent.url.replace('/docs-embed/', '/docs/').replace('/api-embed/', '/api/')} // Convert embed URLs to full URLs
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Open in new tab"
              >
                <ArrowSquareOutIcon className="h-3 w-3" />
              </a>
            </div>
          </div>

          {/* Iframe */}
          <div className="flex-1 min-h-0">
            <iframe
              key={docContent.url} // Force iframe reload when URL changes
              src={docContent.url}
              className="w-full h-full border-0 rounded-md"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              title={docContent.title}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
            />
          </div>
        </div>
      )}
    </div>
  );
}
