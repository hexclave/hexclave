"use client";

import { HexclaveClientApp, clerkTokenStore } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useState } from "react";

type Claims = {
  iss?: string,
  sub?: string,
  sid?: string,
  azp?: string,
  aud?: string | string[],
  exp?: number,
  email?: string,
  name?: string,
};
type ProviderUser = { email: string | null, name: string | null };
type HexclaveUser = { id: string, primaryEmail: string | null, displayName: string | null };
type Exchange = {
  sessionId: string,
  userId: string,
  isNewUser: boolean,
  primaryEmail: string | null,
  displayName: string | null,
};
type Status = "idle" | "exchanging" | "exchanged" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function decodeClaims(token: string): Claims {
  const payload = token.split(".")[1];
  if (payload == null) throw new Error("The Clerk token did not contain a JWT payload");
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) throw new Error("The Clerk token payload was malformed");
  const aud = typeof value.aud === "string"
    || Array.isArray(value.aud) && value.aud.every(item => typeof item === "string")
    ? value.aud
    : undefined;
  return {
    iss: typeof value.iss === "string" ? value.iss : undefined,
    sub: typeof value.sub === "string" ? value.sub : undefined,
    sid: typeof value.sid === "string" ? value.sid : undefined,
    azp: typeof value.azp === "string" ? value.azp : undefined,
    aud,
    exp: typeof value.exp === "number" ? value.exp : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

function parseExchange(value: unknown): Exchange {
  if (
    !isRecord(value)
    || typeof value.sessionId !== "string"
    || typeof value.userId !== "string"
    || typeof value.isNewUser !== "boolean"
    || (value.primaryEmail != null && typeof value.primaryEmail !== "string")
    || (value.displayName != null && typeof value.displayName !== "string")
  ) throw new Error("Clerk exchange response was malformed");
  return {
    sessionId: value.sessionId,
    userId: value.userId,
    isNewUser: value.isNewUser,
    primaryEmail: typeof value.primaryEmail === "string" ? value.primaryEmail : null,
    displayName: typeof value.displayName === "string" ? value.displayName : null,
  };
}

function Claim({ label, value }: { label: string, value: string | number | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd><code>{value == null ? "Not present" : String(value)}</code></dd>
    </>
  );
}

export function ClerkDemo() {
  const [clerk, setClerk] = useState<ClerkInstance | null>(null);
  const [providerUser, setProviderUser] = useState<ProviderUser | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [user, setUser] = useState<HexclaveUser | null>(null);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let interval: number | null = null;
    const loadClerk = () => {
      const clerk = window.Clerk;
      if (!active || clerk == null) return;
      if (interval != null) window.clearInterval(interval);
      runAsynchronouslyWithAlert(async () => {
        await clerk.load({
          publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        });
        if (active) setClerk(clerk);
      });
    };
    interval = window.setInterval(loadClerk, 100);
    loadClerk();
    return () => {
      active = false;
      if (interval != null) window.clearInterval(interval);
    };
  }, []);

  const tokenStore = useMemo(() => clerkTokenStore({
    getSessionId: () => clerk?.session?.id ?? null,
    getToken: async () => await clerk?.session?.getToken() ?? null,
    subscribe: callback => clerk?.addListener(callback) ?? (() => {}),
  }), [clerk]);

  const app = useMemo(() => new HexclaveClientApp({
    baseUrl: process.env.NEXT_PUBLIC_HEXCLAVE_API_URL,
    projectId: process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID,
    publishableClientKey: process.env.NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY,
    tokenStore,
    automaticSideEffects: false,
  }), [tokenStore]);

  useEffect(() => {
    if (clerk == null) return;
    const update = () => {
      const currentUser = clerk.user;
      const currentSession = clerk.session;
      setSessionId(currentSession?.id ?? null);
      setProviderUser(currentUser == null
        ? null
        : {
          email: currentUser.primaryEmailAddress?.emailAddress ?? null,
          name: currentUser.fullName ?? currentUser.firstName ?? null,
        });
      if (currentSession == null) {
        setClaims(null);
        setExchange(null);
        setUser(null);
        setStatus("idle");
      }
    };
    update();
    return clerk.addListener(update);
  }, [clerk]);

  useEffect(() => {
    if (sessionId == null || clerk?.session == null) return;
    let active = true;
    setError(null);
    setStatus("exchanging");
    runAsynchronouslyWithAlert(async () => {
      const token = await clerk.session?.getToken();
      if (token == null) throw new Error("Clerk did not return a session token");
      const response = await fetch("/api/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (isRecord(body) && typeof body.error === "string") throw new Error(body.error);
        throw new Error(`Clerk exchange returned ${response.status}`);
      }
      const result = parseExchange(body);
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
          setError(error instanceof Error ? error.message : "Clerk exchange failed");
        }
      },
    });
    return () => {
      active = false;
    };
  }, [app, clerk, sessionId]);

  const signIn = () => {
    if (clerk == null) return;
    runAsynchronouslyWithAlert(() => clerk.openSignIn());
  };
  const signOut = () => {
    if (clerk == null) return;
    runAsynchronouslyWithAlert(() => clerk.signOut());
  };

  if (clerk == null || sessionId == null) {
    return (
      <>
        <main>
          <p className="eyebrow">External authentication demo</p>
          <h1>Clerk <span>→</span> Hexclave</h1>
          <p className="lede">Sign in with a real Clerk dev instance, then exchange its provider JWT for a Hexclave session.</p>
          <p className="status">Exchange status: <strong>{status}</strong></p>
          {error != null && <p className="error" role="alert">Authentication error: {error}</p>}
          <section className="panel auth-form">
            <p>{clerk == null ? "Loading Clerk…" : "No Clerk session is active."}</p>
            <button type="button" disabled={clerk == null} onClick={signIn}>Sign in with Clerk</button>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      <main>
        <p className="eyebrow">External authentication demo</p>
        <h1>Clerk <span>→</span> Hexclave</h1>
        <p className="lede">A real Clerk session JWT is exchanged for a short-lived Hexclave session without storing the provider token.</p>
        <p className="status">Exchange status: <strong>{status}</strong></p>
        {error != null && <p className="error" role="alert">Exchange error: {error}</p>}
        <div className="panels">
          <section className="panel">
            <p className="panel-kicker">Provider session</p>
            <h2>Clerk</h2>
            <dl>
              <Claim label="User" value={providerUser?.name ?? undefined} />
              <Claim label="Email" value={providerUser?.email ?? undefined} />
              <Claim label="Session ID" value={sessionId} />
            </dl>
            <div className="claims">
              <p className="panel-kicker">Decoded token claims</p>
              <dl>
                <Claim label="iss" value={claims?.iss} />
                <Claim label="sub" value={claims?.sub} />
                <Claim label="sid" value={claims?.sid} />
                <Claim label="azp" value={claims?.azp} />
                <Claim label="aud" value={Array.isArray(claims?.aud) ? claims.aud.join(", ") : claims?.aud} />
                <Claim label="email" value={claims?.email} />
                <Claim label="name" value={claims?.name} />
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
              <Claim label="New user on this exchange" value={exchange == null ? undefined : exchange.isNewUser ? "yes" : "no"} />
              <Claim label="Session ID" value={exchange?.sessionId} />
            </dl>
            <div className="actions">
              <button type="button" onClick={signOut}>Sign out of Clerk</button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
