"use client";

import { HexclaveClientApp, workosTokenStore } from "@hexclave/next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Claims = {
  iss?: string;
  sub?: string;
  sid?: string;
  client_id?: string;
  aud?: string | string[];
  exp?: number;
};
type ProviderSession = {
  accessToken: string;
  sessionId: string;
  user: { email?: string; firstName?: string; lastName?: string } | null;
};
type HexclaveUser = {
  id: string;
  primaryEmail: string | null;
  displayName: string | null;
};
type Exchange = {
  sessionId?: string;
  userId?: string;
  isNewUser?: boolean;
  primaryEmail?: string | null;
  displayName?: string | null;
  error?: string;
};
type Status = "idle" | "exchanging" | "exchanged" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function decodeClaims(token: string): Claims {
  const payload = token.split(".")[1];
  if (payload == null)
    throw new Error("The WorkOS token did not contain a JWT payload");
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) {
    throw new Error("The WorkOS token payload was malformed");
  }
  return {
    iss: typeof value.iss === "string" ? value.iss : undefined,
    sub: typeof value.sub === "string" ? value.sub : undefined,
    sid: typeof value.sid === "string" ? value.sid : undefined,
    client_id: typeof value.client_id === "string" ? value.client_id : undefined,
    aud: typeof value.aud === "string" || Array.isArray(value.aud) && value.aud.every(item => typeof item === "string")
      ? value.aud
      : undefined,
    exp: typeof value.exp === "number" ? value.exp : undefined,
  };
}

function parseProviderSession(value: unknown): ProviderSession {
  if (!isRecord(value)
    || typeof value.accessToken !== "string" || value.accessToken.length === 0
    || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("The WorkOS session response was malformed");
  }
  if (value.user != null && (!isRecord(value.user)
    || (value.user.email != null && typeof value.user.email !== "string")
    || (value.user.firstName != null && typeof value.user.firstName !== "string")
    || (value.user.lastName != null && typeof value.user.lastName !== "string"))) {
    throw new Error("The WorkOS session profile was malformed");
  }
  return {
    accessToken: value.accessToken,
    sessionId: value.sessionId,
    user: value.user == null ? null : {
      email: typeof value.user.email === "string" ? value.user.email : undefined,
      firstName: typeof value.user.firstName === "string" ? value.user.firstName : undefined,
      lastName: typeof value.user.lastName === "string" ? value.user.lastName : undefined,
    },
  };
}

function parseExchange(value: unknown): Exchange {
  if (!isRecord(value)) {
    throw new Error("The WorkOS exchange response was malformed");
  }
  const stringFields = ["sessionId", "userId", "primaryEmail", "displayName", "error"] as const;
  if (stringFields.some(field => value[field] != null && typeof value[field] !== "string")
    || (value.isNewUser != null && typeof value.isNewUser !== "boolean")) {
    throw new Error("The WorkOS exchange response was malformed");
  }
  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    userId: typeof value.userId === "string" ? value.userId : undefined,
    isNewUser: typeof value.isNewUser === "boolean" ? value.isNewUser : undefined,
    primaryEmail: typeof value.primaryEmail === "string" ? value.primaryEmail : null,
    displayName: typeof value.displayName === "string" ? value.displayName : null,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

function Claim({
  label,
  value,
}: {
  label: string;
  value: string | number | undefined;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <code>{value == null ? "Not present" : String(value)}</code>
      </dd>
    </>
  );
}

export function WorkosDemo() {
  const [providerSession, setProviderSession] =
    useState<ProviderSession | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [user, setUser] = useState<HexclaveUser | null>(null);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const providerSessionRef = useRef<ProviderSession | null>(null);
  const providerSessionSubscribers = useRef(new Set<() => void>());
  const lastReportedSessionId = useRef<string | null>(null);
  const updateProviderSession = useCallback((session: ProviderSession | null) => {
    const previousSessionId = providerSessionRef.current?.sessionId ?? null;
    providerSessionRef.current = session;
    setProviderSession(session);
    if (session?.sessionId !== previousSessionId) {
      lastReportedSessionId.current = session?.sessionId ?? null;
      for (const callback of providerSessionSubscribers.current) {
        callback();
      }
    }
  }, []);
  const tokenStore = useMemo(
    () =>
      workosTokenStore({
        getSessionId: () => providerSessionRef.current?.sessionId ?? null,
        // The SDK calls getToken again when the provider session changes or the exchanged token
        // expires, so fetch the current WorkOS JWT instead of reusing the mount-time snapshot.
        getToken: async () => {
          const response = await fetch("/api/auth/provider-session");
          if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
            return null;
          }
          const session = parseProviderSession(await response.json());
          if (session.sessionId !== lastReportedSessionId.current) {
            updateProviderSession(session);
          }
          return session.accessToken;
        },
        subscribe: (callback) => {
          providerSessionSubscribers.current.add(callback);
          return () => providerSessionSubscribers.current.delete(callback);
        },
      }),
    [updateProviderSession],
  );
  const app = useMemo(
    () =>
      new HexclaveClientApp({
        baseUrl: process.env.NEXT_PUBLIC_HEXCLAVE_API_URL,
        projectId: process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID,
        publishableClientKey:
          process.env.NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY,
        tokenStore,
        automaticSideEffects: false,
      }),
    [tokenStore],
  );
  const signOutOfWorkOS = () => {
    setIsSigningOut(true);
    setSignedOut(true);
    updateProviderSession(null);
    setUser(null);
    window.location.assign("/api/auth/signout");
  };

  useEffect(() => {
    if (signedOut) return;
    let active = true;
    setStatus("exchanging");
    Promise.all([
      fetch("/api/auth/provider-session").then(async (response) => {
        if (!response.ok)
          throw new Error(
            `WorkOS session endpoint returned ${response.status}`,
          );
        return parseProviderSession(await response.json());
      }),
      fetch("/api/auth/exchange", { method: "POST" }).then(async (response) => {
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
          throw new Error(`WorkOS exchange returned ${response.status}`);
        }
        return parseExchange(await response.json());
      }),
    ])
      .then(([session, result]) => {
        if (!active) return;
        updateProviderSession(session);
        setClaims(decodeClaims(session.accessToken));
        setExchange(result);
        setUser(
          result.userId == null
            ? null
            : {
              id: result.userId,
              primaryEmail: result.primaryEmail ?? null,
              displayName: result.displayName ?? null,
            },
        );
        setStatus("exchanged");
      })
      .catch((reason) => {
        if (!active) return;
        setStatus("error");
        setError(
          reason instanceof Error ? reason.message : "WorkOS exchange failed",
        );
      });
    return () => {
      active = false;
    };
  }, [signedOut, updateProviderSession]);

  useEffect(() => {
    if (providerSession == null) return;
    let active = true;
    app.getUser().then((sdkUser) => {
      if (active) {
        setUser(sdkUser == null ? null : {
          id: sdkUser.id,
          primaryEmail: sdkUser.primaryEmail,
          displayName: sdkUser.displayName,
        });
      }
    }).catch(() => {
      if (active) setError("Hexclave SDK user lookup failed");
    });
    return () => {
      active = false;
    };
  }, [app, providerSession]);

  if (signedOut) {
    return (
      <main>
        <p className="eyebrow">WorkOS AuthKit</p>
        <h1>Signed out</h1>
        <p className="lede">
          The WorkOS provider session and local Hexclave view are cleared.
        </p>
        <a href="/auth/sign-in">Sign in with WorkOS AuthKit</a>
      </main>
    );
  }

  const providerName = [
    providerSession?.user?.firstName,
    providerSession?.user?.lastName,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <main>
      <p className="eyebrow">External authentication demo</p>
      <h1>
        WorkOS AuthKit <span>→</span> Hexclave
      </h1>
      <p className="lede">
        A genuine WorkOS access token is exchanged for a Hexclave session. The
        raw token never appears here.
      </p>
      <p className="status">
        Exchange status: <strong>{status}</strong>
      </p>
      {error != null && (
        <p className="error" role="alert">
          Exchange error: {error}
        </p>
      )}
      <div className="panels">
        <section className="panel">
          <p className="panel-kicker">Provider session</p>
          <h2>WorkOS AuthKit</h2>
          <dl>
            <Claim
              label="User"
              value={
                providerName ||
                providerSession?.user?.email ||
                "Provider profile did not expose a name"
              }
            />
            <Claim label="Email" value={providerSession?.user?.email} />
            <Claim label="Session ID" value={providerSession?.sessionId} />
          </dl>
          <div className="claims">
            <p className="panel-kicker">Decoded token claims</p>
            <dl>
              <Claim label="iss" value={claims?.iss} />
              <Claim label="sub" value={claims?.sub} />
              <Claim label="sid" value={claims?.sid} />
              <Claim label="client_id" value={claims?.client_id} />
              <Claim
                label="aud"
                value={
                  Array.isArray(claims?.aud)
                    ? claims.aud.join(", ")
                    : claims?.aud
                }
              />
              <Claim label="exp" value={claims?.exp} />
            </dl>
          </div>
        </section>
        <section className="panel">
          <p className="panel-kicker">Hexclave session</p>
          <h2>Project user</h2>
          <dl>
            <Claim label="User ID" value={user?.id} />
            <Claim label="Primary email" value={user?.primaryEmail ?? "null"} />
            <Claim label="Display name" value={user?.displayName ?? "null"} />
            <Claim
              label="New user on this exchange"
              value={
                exchange?.isNewUser == null
                  ? undefined
                  : exchange.isNewUser
                    ? "yes"
                    : "no"
              }
            />
            <Claim label="Session ID" value={exchange?.sessionId} />
          </dl>
          <div className="actions">
            <button
              type="button"
              disabled={isSigningOut || status === "exchanging"}
              onClick={signOutOfWorkOS}
            >
              {isSigningOut ? "Signing out…" : "Sign out of WorkOS"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
