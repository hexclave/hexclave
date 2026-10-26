"use client";

import { HexclaveClientApp, betterAuthTokenStore } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useRef, useState } from "react";

type Claims = {
  iss?: string;
  sub?: string;
  sid?: string;
  aud?: string | string[];
  exp?: number;
};
type ProviderUser = { email: string; name: string };
type HexclaveUser = {
  id: string;
  primaryEmail: string | null;
  displayName: string | null;
};
type Exchange = {
  sessionId: string;
  userId: string;
  isNewUser: boolean;
  primaryEmail: string | null;
  displayName: string | null;
  error?: string;
};
type Status = "idle" | "exchanging" | "exchanged" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function decodeClaims(token: string): Claims {
  const payload = token.split(".")[1];
  if (payload == null)
    throw new Error("The Better Auth token did not contain a JWT payload");
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) throw new Error("The Better Auth token payload was malformed");
  return {
    iss: typeof value.iss === "string" ? value.iss : undefined,
    sub: typeof value.sub === "string" ? value.sub : undefined,
    sid: typeof value.sid === "string" ? value.sid : undefined,
    aud: typeof value.aud === "string" || Array.isArray(value.aud) && value.aud.every(item => typeof item === "string")
      ? value.aud
      : undefined,
    exp: typeof value.exp === "number" ? value.exp : undefined,
  };
}

function parseTokenResponse(value: unknown): string {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length === 0) {
    throw new Error("Better Auth token response was malformed");
  }
  return value.token;
}

function parseSessionResponse(value: unknown): { session?: { id: string }, user?: ProviderUser } {
  if (!isRecord(value)) {
    throw new Error("Better Auth session response was malformed");
  }
  let session: { id: string } | undefined;
  if (value.session != null) {
    if (!isRecord(value.session) || typeof value.session.id !== "string" || value.session.id.length === 0) {
      throw new Error("Better Auth session response was malformed");
    }
    session = { id: value.session.id };
  }
  let user: ProviderUser | undefined;
  if (value.user != null) {
    if (!isRecord(value.user) || typeof value.user.email !== "string" || typeof value.user.name !== "string") {
      throw new Error("Better Auth session response was malformed");
    }
    user = { email: value.user.email, name: value.user.name };
  }
  return {
    session,
    user,
  };
}

function parseExchange(value: unknown): Exchange {
  if (!isRecord(value)) throw new Error("Better Auth exchange response was malformed");
  if (
    typeof value.sessionId !== "string" || value.sessionId.length === 0
    || typeof value.userId !== "string" || value.userId.length === 0
    || typeof value.isNewUser !== "boolean"
    || (value.primaryEmail !== null && value.primaryEmail !== undefined && typeof value.primaryEmail !== "string")
    || (value.displayName !== null && value.displayName !== undefined && typeof value.displayName !== "string")
    || (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error("Better Auth exchange response was malformed");
  }
  return {
    sessionId: value.sessionId,
    userId: value.userId,
    isNewUser: value.isNewUser,
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

export function BetterAuthDemo() {
  const sessionLookupController = useRef<AbortController | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [providerUser, setProviderUser] = useState<ProviderUser | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [user, setUser] = useState<HexclaveUser | null>(null);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const tokenStore = useMemo(
    () =>
      betterAuthTokenStore({
        getSessionId: () => sessionId,
        getToken: async () => {
          const response = await fetch("/api/auth/token");
          if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return null;
          return parseTokenResponse(await response.json());
        },
        subscribe: (callback) => {
          window.addEventListener("better-auth-session-change", callback);
          return () =>
            window.removeEventListener("better-auth-session-change", callback);
        },
      }),
    [sessionId],
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
  const signOutOfBetterAuth = async () => {
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) {
        setError(`Better Auth sign-out returned ${response.status}`);
        setStatus("error");
        return;
      }
      setSessionId(null);
      setProviderUser(null);
      setClaims(null);
      setExchange(null);
      setUser(null);
      setStatus("idle");
      window.dispatchEvent(new Event("better-auth-session-change"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const authenticate = async (path: "sign-up" | "sign-in") => {
    sessionLookupController.current?.abort();
    sessionLookupController.current = null;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/auth/${path}/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, name: email.split("@")[0] }),
      });
      if (!response.ok) {
        setError("Better Auth authentication request failed");
        setStatus("error");
        return;
      }
      const sessionResponse = await fetch("/api/auth/get-session");
      if (!sessionResponse.ok) {
        setError(`Better Auth session endpoint returned ${sessionResponse.status}`);
        setStatus("error");
        return;
      }
      const session = parseSessionResponse(await sessionResponse.json());
      if (session.session == null) {
        setError("Better Auth sign-in succeeded but no session was returned");
        setStatus("error");
        return;
      }
      setProviderUser(session.user ?? { email, name: email.split("@")[0] });
      setSessionId(session.session.id);
      window.dispatchEvent(new Event("better-auth-session-change"));
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    sessionLookupController.current = controller;
    runAsynchronouslyWithAlert(async () => {
      try {
        const response = await fetch("/api/auth/get-session", { signal: controller.signal });
        if (!response.ok) return;
        const session = parseSessionResponse(await response.json());
        if (!active || session.session == null) return;
        setProviderUser(session.user ?? null);
        setSessionId(session.session.id);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        throw error;
      }
    });
    return () => {
      active = false;
      controller.abort();
      if (sessionLookupController.current === controller) {
        sessionLookupController.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (sessionId == null) return;
    let active = true;
    setStatus("exchanging");
    runAsynchronouslyWithAlert(async () => {
      const [token, result] = await Promise.all([
          fetch("/api/auth/token").then(async (response) => {
            if (!response.ok)
              throw new Error(
                `Better Auth token endpoint returned ${response.status}`,
              );
            return parseTokenResponse(await response.json());
          }),
          fetch("/api/auth/exchange", { method: "POST" }).then(async (response) => {
            let body: unknown = null;
            if ((response.headers.get("content-type") ?? "").includes("application/json")) {
              try {
                body = await response.json();
              } catch {
                body = null;
              }
            }
            if (!response.ok) {
              if (isRecord(body) && typeof body.error === "string") {
                throw new Error(body.error);
              }
              throw new Error(
                `Better Auth exchange returned ${response.status}`,
              );
            }
            return parseExchange(body);
          }),
      ]);
      if (!active) return;
      setClaims(decodeClaims(token));
      setExchange(result);
      const sdkUser = await app.getUser();
      if (!active) return;
      setUser(sdkUser == null ? null : {
        id: sdkUser.id,
        primaryEmail: sdkUser.primaryEmail,
        displayName: sdkUser.displayName,
      });
      setStatus("exchanged");
    }, {
      onError: error => {
        if (active) {
          setStatus("error");
          setError(error instanceof Error ? error.message : "Better Auth exchange failed");
        }
      },
    });
    return () => {
      active = false;
    };
  }, [app, sessionId]);

  if (sessionId == null)
    return (
      <main>
        <p className="eyebrow">External authentication demo</p>
        <h1>
          Better Auth <span>→</span> Hexclave
        </h1>
        <p className="lede">
          Sign in to the local Better Auth provider, then watch its JWT become a
          Hexclave session.
        </p>
        <p className="status">
          Exchange status: <strong>{status}</strong>
        </p>
        {error != null && (
          <p className="error" role="alert">
            Authentication error: {error}
          </p>
        )}
        <section className="panel auth-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => runAsynchronouslyWithAlert(() => authenticate("sign-in"))}
            >
              {isSubmitting ? "Signing in…" : "Sign in to Better Auth"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={isSubmitting}
              onClick={() => runAsynchronouslyWithAlert(() => authenticate("sign-up"))}
            >
              Create Better Auth user
            </button>
          </div>
        </section>
      </main>
    );

  return (
    <main>
      <p className="eyebrow">External authentication demo</p>
      <h1>
        Better Auth <span>→</span> Hexclave
      </h1>
      <p className="lede">
        A locally issued Better Auth JWT, including its session ID, is exchanged
        for a Hexclave session.
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
          <h2>Better Auth</h2>
          <dl>
            <Claim label="User" value={providerUser?.name} />
            <Claim label="Email" value={providerUser?.email} />
            <Claim label="Session ID" value={sessionId} />
          </dl>
          <div className="claims">
            <p className="panel-kicker">Decoded token claims</p>
            <dl>
              <Claim label="iss" value={claims?.iss} />
              <Claim label="sub" value={claims?.sub} />
              <Claim label="sid" value={claims?.sid} />
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
              disabled={isSubmitting || status === "exchanging"}
              onClick={() => runAsynchronouslyWithAlert(signOutOfBetterAuth)}
            >
              {isSubmitting ? "Signing out…" : "Sign out of Better Auth"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
