'use client';

/**
 * =============================================================================
 * INTERNAL DEV/QA HARNESS — NOT AN SDK EXAMPLE
 * =============================================================================
 * This page is a manual test harness for the CLI auth flow, not a reference
 * implementation. Do NOT copy patterns from this file into a real app:
 *
 *  - It reaches into `app[hexclaveAppInternalsSymbol]`, which is private SDK surface.
 *  - It stores the CLI refresh token in sessionStorage for debugging only;
 *    real CLIs should use OS-specific secure storage (e.g. a credentials file
 *    with 0600 perms, or the system keychain).
 *  - It bypasses `StackClientApp.promptCliLogin()` and talks to raw endpoints;
 *    real integrations should use the SDK.
 *  - Polling has no retry/backoff — fine for a debug page, bad for prod.
 *
 * For a real CLI login integration, see `packages/cli/src/commands/login.ts`.
 * =============================================================================
 */

import { StackClientApp, useStackApp, useUser, hexclaveAppInternalsSymbol } from '@hexclave/next';
import { isJsonSerializable, parseJson } from '@hexclave/shared/dist/utils/json';
import { runAsynchronouslyWithAlert } from '@hexclave/shared/dist/utils/promises';
import { Button, Card, CardContent, CardHeader, Typography } from '@hexclave/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Phase = 'idle' | 'setting-up' | 'polling' | 'success' | 'error';

type CliState = {
  userId: string | null;
  isAnonymous: boolean;
  refreshToken: string | null;
};

const CLI_STORAGE_KEY = 'stack-cli-demo-state';

function getStackInternals(app: ReturnType<typeof useStackApp>) {
  return app[hexclaveAppInternalsSymbol];
}

type RefreshCliSessionResult =
  | { ok: true; access_token: string }
  | { ok: false; status: number; bodySnippet: string };

async function refreshCliAppSession(cliApp: StackClientApp, refreshToken: string): Promise<RefreshCliSessionResult> {
  const internals = getStackInternals(cliApp);
  const res = await internals.sendRequest('/auth/sessions/current/refresh', {
    method: 'POST',
    headers: { 'x-stack-refresh-token': refreshToken },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, bodySnippet: text.slice(0, 200) };
  }
  const data = await res.json();
  await internals.signInWithTokens({
    accessToken: data.access_token,
    refreshToken,
  });
  return { ok: true, access_token: data.access_token };
}

function parseAccessTokenUserSnapshot(accessToken: string): { userId: string | null; isAnonymous: boolean } {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return { userId: null, isAnonymous: false };
    // JWTs use base64url, not plain base64 — convert before atob.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return {
      userId: payload.userId ?? payload.sub ?? null,
      isAnonymous: payload.iss?.includes(':anon') ?? false,
    };
  } catch {
    return { userId: null, isAnonymous: false };
  }
}

// NOTE: sessionStorage is used so the refresh token does not persist across
// tab restarts. This is still XSS-readable — ONLY acceptable because this is
// a dev harness. Do NOT copy this pattern into real apps.
function loadCliState(): { refreshToken: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = sessionStorage.getItem(CLI_STORAGE_KEY);
    if (stored == null) return null;
    const parsed = parseJson(stored);
    if (parsed.status === 'error' || !isJsonSerializable(parsed.data) || parsed.data === null || Array.isArray(parsed.data) || typeof parsed.data !== 'object') {
      return null;
    }
    const refreshToken = parsed.data.refreshToken;
    return typeof refreshToken === 'string' ? { refreshToken } : null;
  } catch {
    return null;
  }
}

function saveCliState(refreshToken: string | null) {
  if (typeof window === 'undefined') return;
  if (refreshToken) {
    sessionStorage.setItem(CLI_STORAGE_KEY, JSON.stringify({ refreshToken }));
  } else {
    sessionStorage.removeItem(CLI_STORAGE_KEY);
  }
}

function useCliApp() {
  const browserApp = useStackApp();
  const appJson = getStackInternals(browserApp).toClientJson();

  const cliApp = useMemo(() => {
    return new StackClientApp({
      projectId: appJson.projectId,
      publishableClientKey: appJson.publishableClientKey,
      baseUrl: appJson.baseUrl,
      tokenStore: 'memory',
      noAutomaticPrefetch: true,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return cliApp;
}

const TEST_CASES = [
  {
    id: 1,
    browser: 'Not logged in',
    cli: 'Has anon',
    flow: 'Confirm \u2192 claim CLI anon \u2192 sign up \u2192 upgrade in place \u2192 auto-complete',
    setupBrowser: 'sign-out' as const,
    setupCli: 'anon' as const,
  },
  {
    id: 2,
    browser: 'Not logged in',
    cli: 'No anon',
    flow: 'Confirm \u2192 redirect to sign-in \u2192 sign in \u2192 auto-complete',
    setupBrowser: 'sign-out' as const,
    setupCli: 'none' as const,
  },
  {
    id: 3,
    browser: 'Has own anon',
    cli: 'Has anon',
    flow: 'Confirm \u2192 claim CLI anon (replaces browser anon) \u2192 sign up \u2192 upgrade \u2192 auto-complete',
    setupBrowser: 'anon' as const,
    setupCli: 'anon' as const,
  },
  {
    id: 4,
    browser: 'Has own anon',
    cli: 'No anon',
    flow: 'Confirm \u2192 redirect to sign-up \u2192 upgrade browser anon \u2192 auto-complete',
    setupBrowser: 'anon' as const,
    setupCli: 'none' as const,
  },
  {
    id: 5,
    browser: 'Has real user',
    cli: 'Has anon',
    flow: 'Confirm \u2192 complete directly \u2192 merge anon into real user \u2192 CLI gets token',
    setupBrowser: 'keep' as const,
    setupCli: 'anon' as const,
  },
  {
    id: 6,
    browser: 'Has real user',
    cli: 'No anon',
    flow: 'Confirm \u2192 complete directly \u2192 CLI gets token',
    setupBrowser: 'keep' as const,
    setupCli: 'none' as const,
  },
];

export default function CliAuthDemoPage() {
  const browserUser = useUser({ includeRestricted: true });
  const browserApp = useStackApp();
  const cliApp = useCliApp();

  const [cliState, setCliState] = useState<CliState>({ userId: null, isAnonymous: false, refreshToken: null });
  const [hydrated, setHydrated] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [loginCode, setLoginCode] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [activeCase, setActiveCase] = useState<number | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${ts}] ${msg}`]);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    const stored = loadCliState();
    if (stored?.refreshToken) {
      runAsynchronouslyWithAlert(async () => {
        try {
          const refreshed = await refreshCliAppSession(cliApp, stored.refreshToken);
          if (refreshed.ok) {
            const user = await cliApp.getUser({ includeRestricted: true });
            if (user) {
              setCliState({
                userId: user.id,
                isAnonymous: user.isAnonymous,
                refreshToken: stored.refreshToken,
              });
            } else {
              const { userId, isAnonymous } = parseAccessTokenUserSnapshot(refreshed.access_token);
              setCliState({
                userId,
                isAnonymous,
                refreshToken: stored.refreshToken,
              });
            }
          } else {
            saveCliState(null);
          }
        } catch {
          saveCliState(null);
        }
        setHydrated(true);
      });
    } else {
      setHydrated(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetFlow = useCallback(() => {
    stopPolling();
    setPhase('idle');
    setLoginCode(null);
    setRefreshToken(null);
    setPollCount(0);
    setError(null);
    setActiveCase(null);
  }, [stopPolling]);

  const doCliAnonSignUp = useCallback(async () => {
    log('CLI: Creating anonymous user...');
    const anonUser = await cliApp.getUser({ or: 'anonymous' });
    const tokens = await anonUser.currentSession.getTokens();
    const state: CliState = {
      userId: anonUser.id,
      isAnonymous: anonUser.isAnonymous,
      refreshToken: tokens.refreshToken ?? null,
    };
    setCliState(state);
    saveCliState(state.refreshToken);
    log(`CLI: Anonymous user created \u2014 ID: ${state.userId}`);
    return state;
  }, [cliApp, log]);

  const doCliReset = useCallback(async () => {
    try {
      const user = await cliApp.getUser({ includeRestricted: true });
      if (user) {
        await user.signOut();
      }
    } catch {
    }
    setCliState({ userId: null, isAnonymous: false, refreshToken: null });
    saveCliState(null);
  }, [cliApp]);

  const doBrowserSignOut = useCallback(async () => {
    if (browserUser) {
      log('Browser: Signing out...');
      await browserUser.signOut({ redirectUrl: '/cli-auth-demo' });
      log('Browser: Signed out');
    }
  }, [browserUser, log]);

  const doBrowserAnonSignUp = useCallback(async () => {
    log('Browser: Creating anonymous user...');
    const user = await browserApp.getUser({ or: 'anonymous' });
    log(`Browser: Anonymous user created \u2014 ID: ${user.id}`);
  }, [browserApp, log]);

  const startCliAuth = useCallback(async (cliStateOverride?: CliState) => {
    const state = cliStateOverride ?? cliState;
    const anonToken = state.isAnonymous ? state.refreshToken : undefined;
    log(`CLI: Starting promptCliLogin()...${anonToken ? ' (with anon_refresh_token)' : ''}`);

    setPhase('polling');

    const result = await cliApp.promptCliLogin({
      appUrl: window.location.origin,
      anonRefreshToken: anonToken ?? undefined,
      promptLink: (url: string, code: string) => {
        setLoginCode(code);
        log(`CLI: Verification code: ${code}`);
        log(`CLI: Browser URL: ${url}`);
      },
    });

    if (result.status === 'ok') {
      stopPolling();
      setRefreshToken(result.data);
      setPhase('success');
      log(`CLI: Login successful! Token: ${result.data.slice(0, 24)}...`);

      try {
        const refreshed = await refreshCliAppSession(cliApp, result.data);
        if (refreshed.ok) {
          const { userId, isAnonymous } = parseAccessTokenUserSnapshot(refreshed.access_token);
          setCliState({ userId, isAnonymous, refreshToken: result.data });
          saveCliState(result.data);
          log(`CLI: Now authenticated as user: ${userId}${isAnonymous ? ' (anonymous)' : ''}`);
        } else {
          log(`CLI: Token refresh failed (${refreshed.status}): ${refreshed.bodySnippet}`);
          setCliState({ userId: '(unknown)', isAnonymous: false, refreshToken: result.data });
          saveCliState(result.data);
        }
      } catch (err) {
        log(`CLI: Token resolve error: ${err instanceof Error ? err.message : String(err)}`);
        setCliState({ userId: '(unknown)', isAnonymous: false, refreshToken: result.data });
        saveCliState(result.data);
      }
    } else {
      setPhase('error');
      setError(result.error.message);
      log(`CLI: Error: ${result.error.message}`);
    }
  }, [cliApp, cliState, log, stopPolling]);

  const runTestCase = useCallback(async (tc: typeof TEST_CASES[number]) => {
    resetFlow();
    setLogs([]);
    setActiveCase(tc.id);
    setPhase('setting-up');
    log(`\u2501\u2501\u2501 Test Case ${tc.id}: Browser=${tc.browser}, CLI=${tc.cli} \u2501\u2501\u2501`);

    await doCliReset();
    let newCliState: CliState = { userId: null, isAnonymous: false, refreshToken: null };
    if (tc.setupCli === 'anon') {
      newCliState = await doCliAnonSignUp();
    } else {
      log('CLI: No user (reset)');
    }

    if (tc.setupBrowser === 'sign-out') {
      await doBrowserSignOut();
    } else if (tc.setupBrowser === 'anon') {
      await doBrowserSignOut();
      await doBrowserAnonSignUp();
    } else {
      if (!browserUser || browserUser.isAnonymous) {
        log('Browser: \u26a0\ufe0f Need a real user for this case. Please sign in first, then retry.');
        setPhase('error');
        setError('Browser must be signed in as a real (non-anonymous) user for this test case. Sign in first.');
        return;
      }
      log(`Browser: Keeping current user \u2014 ID: ${browserUser.id}`);
    }

    log('Setup complete. Starting CLI auth...');

    await startCliAuth(newCliState);
  }, [resetFlow, log, doCliReset, doCliAnonSignUp, doBrowserSignOut, doBrowserAnonSignUp, browserUser, startCliAuth]);

  useEffect(() => {
    if (phase !== 'polling') return;
    const id = setInterval(() => {
      setPollCount(c => c + 1);
    }, 2000);
    pollingRef.current = id;
    return () => clearInterval(id);
  }, [phase]);

  const confirmUrl = loginCode && typeof window !== 'undefined'
    ? `${window.location.origin}/handler/cli-auth-confirm?login_code=${encodeURIComponent(loginCode)}`
    : null;

  const browserState = !browserUser ? 'Not logged in' : browserUser.isAnonymous ? 'Anonymous' : 'Authenticated';
  const cliStateLabel = !cliState.userId ? 'No session' : cliState.isAnonymous ? 'Anonymous' : 'Authenticated';

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <Typography type="h1" className="mb-2">CLI Auth Flow Demo</Typography>
      <Typography className="mb-6 text-gray-500 text-sm">
        Two separate StackClientApp instances. Pick a test case to auto-setup both sides and run the flow.
      </Typography>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <span className="font-semibold">Browser:</span>{' '}
          <span className={!browserUser ? 'text-gray-400' : browserUser.isAnonymous ? 'text-yellow-600' : 'text-green-600'}>
            {browserState}
          </span>
          {browserUser && <span className="text-gray-400 text-xs ml-2">{browserUser.id.slice(0, 8)}...</span>}
        </div>
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <span className="font-semibold">CLI:</span>{' '}
          {!hydrated ? <span className="text-gray-400">Loading...</span> : (
            <span className={!cliState.userId ? 'text-gray-400' : cliState.isAnonymous ? 'text-yellow-600' : 'text-green-600'}>
              {cliStateLabel}
            </span>
          )}
          {cliState.userId && <span className="text-gray-400 text-xs ml-2">{cliState.userId.slice(0, 8)}...</span>}
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <Typography type="h3">Test Cases</Typography>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-3 w-8">#</th>
                  <th className="py-2 pr-3">Browser</th>
                  <th className="py-2 pr-3">CLI</th>
                  <th className="py-2 pr-3">Flow</th>
                  <th className="py-2 w-20" />
                </tr>
              </thead>
              <tbody>
                {TEST_CASES.map((tc) => (
                  <tr key={tc.id} className={`border-b last:border-0 ${activeCase === tc.id ? 'bg-blue-50' : ''}`}>
                    <td className="py-2 pr-3 font-mono font-bold">{tc.id}</td>
                    <td className="py-2 pr-3">{tc.browser}</td>
                    <td className="py-2 pr-3">{tc.cli}</td>
                    <td className="py-2 pr-3 text-gray-600 text-xs">{tc.flow}</td>
                    <td className="py-2">
                      <Button
                        variant={activeCase === tc.id ? 'default' : 'secondary'}
                        onClick={() => runAsynchronouslyWithAlert(() => runTestCase(tc))}
                        disabled={phase === 'polling' || phase === 'setting-up'}
                      >
                        {activeCase === tc.id && phase === 'setting-up' ? 'Setting up...' : activeCase === tc.id && phase === 'polling' ? 'Running...' : 'Run'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 mt-4 pt-3 border-t">
            <Typography className="text-xs text-gray-400">
              Manual controls:
            </Typography>
            <Button
              variant="secondary"
              onClick={() => runAsynchronouslyWithAlert(
                async () => { await browserApp.redirectToSignIn(); },
              )}
            >
              Browser Sign In
            </Button>
            {browserUser && (
              <Button
                variant="secondary"
                onClick={() => runAsynchronouslyWithAlert(
                  async () => { await browserUser.signOut({ redirectUrl: '/cli-auth-demo' }); },
                )}
              >
                Browser Sign Out
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                resetFlow();
                setLogs([]);
                runAsynchronouslyWithAlert(doCliReset);
              }}
            >
              Reset All
            </Button>
          </div>
        </CardContent>
      </Card>

      {phase !== 'idle' && (
        <Card className="mb-6">
          <CardHeader>
            <Typography type="h3">
              {activeCase ? `Case ${activeCase} ` : ''}CLI Auth Flow
            </Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {loginCode && (
                <div className="rounded-lg border-2 border-dashed border-gray-300 p-6 text-center">
                  <Typography className="text-xs text-gray-500 mb-2">CLI verification code:</Typography>
                  <div className="font-mono text-4xl font-bold tracking-[0.4em] mb-2">
                    {loginCode}
                  </div>
                </div>
              )}

              {confirmUrl && phase === 'polling' && (
                <div className="bg-blue-50 rounded-lg p-4 flex items-center gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => { window.open(confirmUrl, '_blank'); }}
                  >
                    Open Confirmation Page
                  </Button>
                  <Typography className="text-xs text-gray-500">Opens in new tab</Typography>
                </div>
              )}

              {phase === 'setting-up' && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                  Setting up browser and CLI state...
                </div>
              )}
              {phase === 'polling' && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                  Polling... ({pollCount} attempts)
                </div>
              )}

              {phase === 'success' && refreshToken && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <Typography className="font-semibold text-green-800 mb-1">Login Successful!</Typography>
                  <code className="block text-xs bg-white p-2 rounded break-all border">
                    {refreshToken}
                  </code>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <Typography className="text-red-800">{error}</Typography>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {logs.length > 0 && (
        <Card>
          <CardHeader>
            <Typography type="h3">Console Log</Typography>
          </CardHeader>
          <CardContent>
            <div className="bg-gray-900 text-green-400 font-mono text-xs p-4 rounded-lg max-h-80 overflow-y-auto">
              {logs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
