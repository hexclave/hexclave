"use client";

import { useStackApp, useUser } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { isJsonSerializable, parseJson, type Json, type JsonObject } from "@hexclave/shared/dist/utils/json";
import { Button, Card, Switch, Typography } from "@hexclave/ui";
import { useState } from "react";

// Decode JWT without verification (for display purposes only)
function decodeJwt(token: string): JsonObject | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const parsed = parseJson(atob(parts[1]));
    if (parsed.status !== "ok" || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

// Format timestamp fields as readable dates
function formatPayload(payload: JsonObject): JsonObject {
  const formatted: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if ((key === 'iat' || key === 'exp' || key === 'nbf') && typeof value === 'number') {
      const date = new Date(value * 1000);
      formatted[key] = `${value} (${date.toLocaleString()})`;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      formatted[key] = formatPayload(value);
    } else {
      formatted[key] = value;
    }
  }
  return formatted;
}

function AccessTokenViewer({ token }: { token: string | null | undefined }) {
  if (!token) return null;

  const payload = decodeJwt(token);
  if (!payload) return null;

  const formatted = formatPayload(payload);

  return (
    <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
      <Typography variant="secondary" className="text-xs font-medium mb-1 text-blue-600 dark:text-blue-400">
        🔍 Decoded JWT Payload
      </Typography>
      <pre className="text-xs overflow-auto text-blue-700 dark:text-blue-300 font-mono whitespace-pre-wrap">
        {JSON.stringify(formatted, null, 2)}
      </pre>
    </div>
  );
}

function TokenDisplay({ label, value, isLoading, showDecoded }: { label: string, value: string | null | undefined, isLoading?: boolean, showDecoded?: boolean }) {
  const truncated = value && value.length > 80 ? `${value.slice(0, 40)}...${value.slice(-40)}` : value;
  return (
    <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
      <Typography variant="secondary" className="text-xs font-medium mb-1 text-gray-500 dark:text-gray-400">
        {label}
      </Typography>
      {isLoading ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : value ? (
        <>
          <code className="text-xs break-all text-green-600 dark:text-green-400 font-mono">{truncated}</code>
          {showDecoded && <AccessTokenViewer token={value} />}
        </>
      ) : (
        <span className="text-sm text-gray-400 italic">null</span>
      )}
    </div>
  );
}

function JsonDisplay({ label, value, isLoading, accessTokenKey }: { label: string, value: Json | null | undefined, isLoading?: boolean, accessTokenKey?: string }) {
  const accessToken = accessTokenKey && value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && typeof value[accessTokenKey] === "string"
    ? value[accessTokenKey]
    : null;
  return (
    <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
      <Typography variant="secondary" className="text-xs font-medium mb-1 text-gray-500 dark:text-gray-400">
        {label}
      </Typography>
      {isLoading ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : value ? (
        <>
          <pre className="text-xs overflow-auto text-green-600 dark:text-green-400 font-mono">
            {JSON.stringify(value, null, 2)}
          </pre>
          {accessToken && <AccessTokenViewer token={accessToken} />}
        </>
      ) : (
        <span className="text-sm text-gray-400 italic">null</span>
      )}
    </div>
  );
}

type OptionalTokenMethodName =
  | "useAccessToken"
  | "useRefreshToken"
  | "useAuthorizationHeader"
  | "useAuthHeaders"
  | "useAuthJson"
  | "getAccessToken"
  | "getRefreshToken"
  | "getAuthorizationHeader";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOptionalMethod(owner: unknown, name: OptionalTokenMethodName): unknown {
  if (!isRecord(owner)) return undefined;
  const method = owner[name];
  return typeof method === "function" ? method.call(owner) : undefined;
}

function readOptionalToken(owner: unknown, name: OptionalTokenMethodName): string | null {
  const value = readOptionalMethod(owner, name);
  return typeof value === "string" ? value : null;
}

async function readOptionalTokenAsync(owner: unknown, name: OptionalTokenMethodName): Promise<string | null> {
  const value = await readOptionalMethod(owner, name);
  return typeof value === "string" ? value : null;
}

function readOptionalJson(owner: unknown, name: OptionalTokenMethodName): Json | null {
  const value = readOptionalMethod(owner, name);
  return isJsonSerializable(value) ? value : null;
}

function HookBasedTokens() {
  const user = useUser();
  const app = useStackApp();

  if (!user) {
    return (
      <Card className="p-4">
        <Typography variant="secondary" className="text-center text-gray-500">
          Sign in to see hook-based token values
        </Typography>
      </Card>
    );
  }

  // Using the hook variants
  const accessToken = readOptionalToken(user, "useAccessToken");
  const refreshToken = readOptionalToken(user, "useRefreshToken");
  const authorizationHeader = readOptionalToken(user, "useAuthorizationHeader");
  const authHeaders = readOptionalJson(user, "useAuthHeaders");
  const authJson = readOptionalJson(user, "useAuthJson");
  const sessionTokens = user.currentSession.useTokens();

  // App-level hooks
  const appAccessToken = readOptionalToken(app, "useAccessToken");
  const appRefreshToken = readOptionalToken(app, "useRefreshToken");
  const appAuthorizationHeader = readOptionalToken(app, "useAuthorizationHeader");
  const appAuthHeaders = readOptionalJson(app, "useAuthHeaders");
  const appAuthJson = readOptionalJson(app, "useAuthJson");

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <Typography variant="primary" className="mb-4 text-lg font-semibold">
          🪝 Hook-based Methods (user.use*)
        </Typography>
        <Typography variant="secondary" className="mb-4 text-sm text-gray-500">
          These hooks provide reactive access to tokens and re-render when tokens change.
        </Typography>

        <TokenDisplay label="user.useAccessToken()" value={accessToken} showDecoded />
        <TokenDisplay label="user.useRefreshToken()" value={refreshToken} />
        <TokenDisplay label="user.useAuthorizationHeader()" value={authorizationHeader} />
        <JsonDisplay label="user.useAuthHeaders() [deprecated]" value={authHeaders} />
        <JsonDisplay label="user.useAuthJson()" value={authJson} accessTokenKey="accessToken" />
        <JsonDisplay label="user.currentSession.useTokens()" value={sessionTokens} accessTokenKey="accessToken" />
      </Card>

      <Card className="p-4">
        <Typography variant="primary" className="mb-4 text-lg font-semibold">
          🪝 Hook-based Methods (app.use*)
        </Typography>
        <Typography variant="secondary" className="mb-4 text-sm text-gray-500">
          App-level hooks work the same but don&apos;t require having a user object first.
        </Typography>

        <TokenDisplay label="app.useAccessToken()" value={appAccessToken} showDecoded />
        <TokenDisplay label="app.useRefreshToken()" value={appRefreshToken} />
        <TokenDisplay label="app.useAuthorizationHeader()" value={appAuthorizationHeader} />
        <JsonDisplay label="app.useAuthHeaders() [deprecated]" value={appAuthHeaders} />
        <JsonDisplay label="app.useAuthJson()" value={appAuthJson} accessTokenKey="accessToken" />
      </Card>
    </div>
  );
}

function AsyncBasedTokens() {
  const user = useUser();
  const app = useStackApp();

  const [isLoading, setIsLoading] = useState(false);
  const [asyncResults, setAsyncResults] = useState<{
    userAccessToken?: string | null,
    userRefreshToken?: string | null,
    userAuthorizationHeader?: string | null,
    userAuthHeaders?: { "x-stack-auth": string } | null,
    userAuthJson?: { accessToken: string | null, refreshToken: string | null } | null,
    sessionTokens?: { accessToken: string | null, refreshToken: string | null } | null,
    appAccessToken?: string | null,
    appRefreshToken?: string | null,
    appAuthorizationHeader?: string | null,
    appAuthHeaders?: { "x-stack-auth": string } | null,
    appAuthJson?: { accessToken: string | null, refreshToken: string | null } | null,
  } | null>(null);

  const fetchAsyncTokens = async () => {
    setIsLoading(true);
    try {
      const results: typeof asyncResults = {};

      if (user) {
        results.userAccessToken = await readOptionalTokenAsync(user, "getAccessToken");
        results.userRefreshToken = await readOptionalTokenAsync(user, "getRefreshToken");
        results.userAuthorizationHeader = await readOptionalTokenAsync(user, "getAuthorizationHeader");
        results.userAuthHeaders = await user.getAuthHeaders();
        results.userAuthJson = await user.getAuthJson();
        results.sessionTokens = await user.currentSession.getTokens();
      }

      results.appAccessToken = await readOptionalTokenAsync(app, "getAccessToken");
      results.appRefreshToken = await readOptionalTokenAsync(app, "getRefreshToken");
      results.appAuthorizationHeader = await readOptionalTokenAsync(app, "getAuthorizationHeader");
      results.appAuthHeaders = await app.getAuthHeaders();
      results.appAuthJson = await app.getAuthJson();

      setAsyncResults(results);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <Typography variant="primary" className="mb-4 text-lg font-semibold">
          ⏳ Async Methods (user.get*)
        </Typography>
        <Typography variant="secondary" className="mb-4 text-sm text-gray-500">
          These async methods fetch tokens on demand. Click the button to fetch current values.
        </Typography>

        <Button
          onClick={() => runAsynchronouslyWithAlert(fetchAsyncTokens())}
          disabled={isLoading}
          className="mb-4"
        >
          {isLoading ? "Fetching..." : "Fetch Async Tokens"}
        </Button>

        {!user && (
          <Typography variant="secondary" className="text-center text-gray-500 mb-4">
            Sign in to see user-level async token values
          </Typography>
        )}

        {user && (
          <>
            <TokenDisplay label="await user.getAccessToken()" value={asyncResults?.userAccessToken} isLoading={isLoading && !asyncResults} showDecoded />
            <TokenDisplay label="await user.getRefreshToken()" value={asyncResults?.userRefreshToken} isLoading={isLoading && !asyncResults} />
            <TokenDisplay label="await user.getAuthorizationHeader()" value={asyncResults?.userAuthorizationHeader} isLoading={isLoading && !asyncResults} />
            <JsonDisplay label="await user.getAuthHeaders() [deprecated]" value={asyncResults?.userAuthHeaders} isLoading={isLoading && !asyncResults} />
            <JsonDisplay label="await user.getAuthJson()" value={asyncResults?.userAuthJson} isLoading={isLoading && !asyncResults} accessTokenKey="accessToken" />
            <JsonDisplay label="await user.currentSession.getTokens()" value={asyncResults?.sessionTokens} isLoading={isLoading && !asyncResults} accessTokenKey="accessToken" />
          </>
        )}
      </Card>

      <Card className="p-4">
        <Typography variant="primary" className="mb-4 text-lg font-semibold">
          ⏳ Async Methods (app.get*)
        </Typography>
        <Typography variant="secondary" className="mb-4 text-sm text-gray-500">
          App-level async methods work even without getting a user object first.
        </Typography>

        <TokenDisplay label="await app.getAccessToken()" value={asyncResults?.appAccessToken} isLoading={isLoading && !asyncResults} showDecoded />
        <TokenDisplay label="await app.getRefreshToken()" value={asyncResults?.appRefreshToken} isLoading={isLoading && !asyncResults} />
        <TokenDisplay label="await app.getAuthorizationHeader()" value={asyncResults?.appAuthorizationHeader} isLoading={isLoading && !asyncResults} />
        <JsonDisplay label="await app.getAuthHeaders() [deprecated]" value={asyncResults?.appAuthHeaders} isLoading={isLoading && !asyncResults} />
        <JsonDisplay label="await app.getAuthJson()" value={asyncResults?.appAuthJson} isLoading={isLoading && !asyncResults} accessTokenKey="accessToken" />
      </Card>
    </div>
  );
}

export default function TokensDemoPage() {
  const [hooksEnabled, setHooksEnabled] = useState(false);
  const user = useUser();

  return (
    <div className="stack-scope min-h-screen flex items-center justify-center p-4 md:p-8">
      <div className="max-w-5xl w-full mx-auto">
        <div className="mb-8 text-center">
          <Typography variant="primary" className="text-2xl font-bold mb-2">
            🔑 Token Functions Demo
          </Typography>
          <Typography variant="secondary" className="text-gray-500">
            This page demonstrates all the token-related functions available in Hexclave.
          </Typography>
          {!user && (
            <div className="mt-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg inline-block">
              <Typography variant="secondary" className="text-yellow-700 dark:text-yellow-400">
                ⚠️ Sign in to see token values. Currently not authenticated.
              </Typography>
            </div>
          )}
          {user && (
            <div className="mt-4 p-4 bg-green-50 dark:bg-green-900/20 rounded-lg inline-block">
              <Typography variant="secondary" className="text-green-700 dark:text-green-400">
                ✅ Signed in as {user.primaryEmail || user.displayName || user.id}
              </Typography>
            </div>
          )}
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <div className="flex items-center justify-center gap-3 mb-4">
              <Typography variant="primary" className="text-xl font-semibold text-center">
                React Hooks (Synchronous)
              </Typography>
              <Switch
                checked={hooksEnabled}
                onCheckedChange={setHooksEnabled}
              />
            </div>
            {hooksEnabled ? (
              <HookBasedTokens />
            ) : (
              <Card className="p-8 text-center">
                <Typography variant="secondary" className="text-gray-500">
                  Enable the toggle to render hooks
                </Typography>
              </Card>
            )}
          </div>

          <div>
            <Typography variant="primary" className="text-xl font-semibold mb-4 text-center">
              Async Functions
            </Typography>
            <AsyncBasedTokens />
          </div>
        </div>

        <Card className="mt-8 p-4">
          <Typography variant="primary" className="text-lg font-semibold mb-4">
            📚 Usage Notes
          </Typography>
          <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
            <p>
              <strong>useAccessToken() / getAccessToken():</strong> Returns the short-lived JWT access token used for API authentication.
            </p>
            <p>
              <strong>useRefreshToken() / getRefreshToken():</strong> Returns the long-lived refresh token used to obtain new access tokens.
            </p>
            <p>
              <strong>useAuthorizationHeader() / getAuthorizationHeader():</strong> Returns a `Bearer ...` value for the HTTP `Authorization` header.
            </p>
            <p>
              <strong className="text-yellow-600">useAuthHeaders() / getAuthHeaders() [deprecated]:</strong> Returns legacy `x-stack-auth` headers. Prefer authorization-header methods.
            </p>
            <p>
              <strong>useAuthJson() / getAuthJson():</strong> Returns both tokens as JSON. This is the recommended format for non-HTTP protocols.
            </p>
            <p>
              <strong>currentSession.useTokens() / getTokens():</strong> Returns both tokens from the current session object.
            </p>
          </div>
        </Card>

        <Card className="mt-4 p-4">
          <Typography variant="primary" className="text-lg font-semibold mb-4">
            🔍 JWT Payload Fields
          </Typography>
          <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
            <p><strong>iat</strong> (Issued At): When the token was created</p>
            <p><strong>exp</strong> (Expiration): When the token expires</p>
            <p><strong>sub</strong> (Subject): The user ID</p>
            <p><strong>iss</strong> (Issuer): The token issuer (Hexclave)</p>
            <p><strong>aud</strong> (Audience): The intended recipient (your project ID)</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
