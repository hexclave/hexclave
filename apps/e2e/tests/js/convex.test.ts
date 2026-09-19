import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { decodeJwt } from "jose";
import { it } from "../helpers";
import { createApp } from "./js-helpers";


class MockWebSocket {
  static last: MockWebSocket | undefined;
  url: string;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  sent: Array<{ raw: any, json: any }> = [];
  constructor(url: string) {
    this.url = url;
    MockWebSocket.last = this;
  }
  send(data: any) {
    let json: any;
    try {
      json = JSON.parse(String(data));
    } catch {
      json = null;
    }
    this.sent.push({ raw: data, json });
  }
  close() {
    if (this.onclose) this.onclose({ code: 1000, reason: "" } as any);
  }
  open() {
    if (this.onopen) this.onopen({} as any);
  }
}

const signIn = async (clientApp: any) => {
  await clientApp.signUpWithCredential({
    email: "test@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  await clientApp.signInWithCredential({
    email: "test@test.com",
    password: "password",
  });
};

it("should provide a valid auth getter for Convex React client", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const getter = clientApp.getConvexClientAuth({ tokenStore: "memory" });
  const token2 = await getter({ forceRefreshToken: true });
  expect(typeof token2).toBe("string");
  expect((token2 as string).length).toBeGreaterThan(1);

  const convex = new ConvexReactClient("http://localhost:1234", { webSocketConstructor: MockWebSocket as any, expectAuth: true });
  convex.setAuth(getter);
  MockWebSocket.last?.open();
  // wait up to 1s (10 x 100ms) until both Connect and Authenticate messages are seen
  let connectMsg: any = undefined;
  let authMsg: any = undefined;
  for (let i = 0; i < 10; i++) {
    const msgs = (MockWebSocket.last?.sent ?? []).map(m => m.json);
    connectMsg = msgs.find(m => m?.type === "Connect");
    authMsg = msgs.find(m => m?.type === "Authenticate" && m?.tokenType === "User");
    if (connectMsg && authMsg) break;
    await new Promise(r => setTimeout(r, 100));
  }
  expect(connectMsg).toBeDefined();
  expect(authMsg).toBeDefined();
  expect((authMsg as any).value).toBe(token2);
});

it("should provide a valid auth token for Convex HTTP client", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const token = await clientApp.getConvexHttpClientAuth({ tokenStore: "memory" });
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(1);

  const user = await clientApp.getUser({ or: "throw" });
  const payload: any = decodeJwt(token);
  expect(payload.sub).toBe(user.id);

  const convex = new ConvexHttpClient("http://localhost:1234");
  convex.setAuth(token);

  const originalFetch = globalThis.fetch;
  let capturedAuth: string | undefined;
  globalThis.fetch = (async (_input: any, init?: any) => {
    capturedAuth = init?.headers?.Authorization;
    return new Response(JSON.stringify({ status: "success", value: null, logLines: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    await (convex as any).function("any");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(capturedAuth).toBe(`Bearer ${token}`);
});

it("should map convex ctx identity to partial user", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" });
  const identity = {
    subject: user.id,
    name: user.displayName,
    email: user.primaryEmail,
    email_verified: user.primaryEmailVerified,
    selected_team_id: "selected-team-id",
    is_anonymous: user.isAnonymous,
    is_restricted: user.isRestricted,
    restricted_reason: user.restrictedReason,
  } as const;

  const ctx: any = {
    auth: {
      getUserIdentity: async () => identity,
    },
  };

  const partialUser = await clientApp.getPartialUser({ from: "convex", ctx });
  expect(partialUser).toEqual({
    id: user.id,
    displayName: user.displayName,
    primaryEmail: user.primaryEmail,
    primaryEmailVerified: user.primaryEmailVerified,
    selectedTeamId: "selected-team-id",
    isAnonymous: user.isAnonymous,
    isRestricted: false,
    restrictedReason: null,
  });
});

it("should map a missing selected_team_id claim to a null selectedTeamId", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" });
  const ctx: any = {
    auth: {
      getUserIdentity: async () => ({ subject: user.id }),
    },
  };

  const partialUser = await clientApp.getPartialUser({ from: "convex", ctx });
  expect(partialUser?.selectedTeamId).toBeNull();
});

it("should return null partial user when convex identity is absent", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const ctx: any = {
    auth: {
      getUserIdentity: async () => null,
    },
  };

  const partialUser = await clientApp.getPartialUser({ from: "convex", ctx });
  expect(partialUser).toBeNull();
});


it("should return the server user when provided Convex ctx identity", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" });
  const identity = { subject: user.id } as const;

  const ctx: any = {
    auth: {
      getUserIdentity: async () => identity,
    },
  };

  const serverUser = await serverApp.getUser({ from: "convex", ctx });
  expect(serverUser).not.toBeNull();
  expect(serverUser!.id).toBe(user.id);
  expect(serverUser!.isAnonymous).toBe(false);
});

it("should return null when Convex ctx identity is absent for server getUser", async ({ expect }) => {
  const { serverApp } = await createApp({});

  const ctx: any = {
    auth: {
      getUserIdentity: async () => null,
    },
  };

  const serverUser = await serverApp.getUser({ from: "convex", ctx });
  expect(serverUser).toBeNull();
});


