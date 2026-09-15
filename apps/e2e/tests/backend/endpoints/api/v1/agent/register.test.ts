import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { it } from "../../../../../helpers";
import { Auth, backendContext, niceBackendFetch, Project } from "../../../../backend-helpers";

async function createProjectWithAgentAuth() {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });
}

async function registerAgent(body: Record<string, unknown> = {}) {
  const response = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: {
      agent: { name: "Claude Code", description: "Triage support tickets", url: "https://example.com/agent" },
      user_hint: "alice@example.com",
      ...body,
    },
  });
  if (response.status !== 200) {
    throw new HexclaveAssertionError("Agent registration failed in test setup", { response });
  }
  return response;
}

async function pollAgent(pollToken: string) {
  return await niceBackendFetch("/api/v1/agent/register/poll", {
    method: "POST",
    accessType: "client",
    body: { poll_token: pollToken },
  });
}

async function confirmAgent(claimCode: string, action: "inspect" | "approve" | "deny") {
  return await niceBackendFetch("/api/v1/agent/register/confirm", {
    method: "POST",
    accessType: "client",
    body: { claim_code: claimCode, action },
  });
}

it("rejects registration when the agent-auth app is not enabled", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Claude Code" } },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "AGENT_AUTH_NOT_ENABLED",
        "error": "Agent authentication is not enabled for this project. Install the Agent Auth app in the Hexclave dashboard to enable it.",
      },
      "headers": Headers {
        "x-stack-known-error": "AGENT_AUTH_NOT_ENABLED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("registers an agent and returns a claim code, confirm URL, poll token and anonymous session", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const response = await registerAgent();
  expect(response.body).toMatchInlineSnapshot(`
    {
      "anonymous_session": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "claim_code": <stripped field 'claim_code'>,
      "confirm_url": <stripped field 'confirm_url'>,
      "expires_at_millis": <stripped field 'expires_at_millis'>,
      "poll_token": <stripped field 'poll_token'>,
    }
  `);
  expect(response.body.claim_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  const confirmUrl = new URL(response.body.confirm_url);
  expect(confirmUrl.pathname).toMatch(/\/handler\/agent-auth-confirm$/);
  expect(confirmUrl.searchParams.get("code")).toBe(response.body.claim_code);
  expect(response.body.expires_at_millis).toBeGreaterThan(Date.now());
});

it("builds the confirm URL on the project's own app when one is configured or passed", async ({ expect }) => {
  await createProjectWithAgentAuth();
  await Project.updateConfig({
    "domains.trustedDomains.app": { baseUrl: "https://app.example.com", handlerPath: "/auth" },
    "domains.trustedDomains.wild": { baseUrl: "https://*.preview.example.com", handlerPath: "/handler" },
  });

  const implicit = await registerAgent();
  expect(implicit.body.confirm_url).toBe(`https://app.example.com/auth/agent-auth-confirm?code=${encodeURIComponent(implicit.body.claim_code)}`);

  const explicit = await registerAgent({ app_url: "https://pr-42.preview.example.com/some/page" });
  expect(explicit.body.confirm_url).toBe(`https://pr-42.preview.example.com/handler/agent-auth-confirm?code=${encodeURIComponent(explicit.body.claim_code)}`);

  const untrusted = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Claude Code" }, app_url: "https://evil.example.org" },
  });
  expect(untrusted).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "REDIRECT_URL_NOT_WHITELISTED",
        "details": { "redirect_url": "https://evil.example.org" },
        "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
      },
      "headers": Headers {
        "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("lets the anonymous session call the API only when anonymous users are explicitly allowed", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body } = await registerAgent();
  const anonymousAuth = { accessToken: body.anonymous_session.access_token, refreshToken: body.anonymous_session.refresh_token };

  const rejected = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    userAuth: anonymousAuth,
    headers: { "x-stack-allow-anonymous-user": "false" },
  });
  expect(rejected.status).toBe(401);
  expect(rejected.body.code).toBe("ANONYMOUS_AUTHENTICATION_NOT_ALLOWED");

  const allowed = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    userAuth: anonymousAuth,
    headers: { "x-stack-allow-anonymous-user": "true" },
  });
  expect(allowed.status).toBe(200);
  expect(allowed.body.id).toBe(body.anonymous_session.user_id);
  expect(allowed.body.is_anonymous).toBe(true);
});

it("reports pending while nobody has approved", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body } = await registerAgent();
  const poll = await pollAgent(body.poll_token);
  expect(poll).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "status": "pending" },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects an unknown poll token", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const poll = await pollAgent("not-a-real-token");
  expect(poll).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "AGENT_AUTH_INVALID_POLL_TOKEN",
        "error": "The poll token is invalid or does not exist.",
      },
      "headers": Headers {
        "x-stack-known-error": "AGENT_AUTH_INVALID_POLL_TOKEN",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("approves an agent, hands the session to the poller exactly once, and tags the session with the agent name", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body: registration } = await registerAgent();

  const user = await Auth.fastSignUp();

  const inspect = await confirmAgent(registration.claim_code, "inspect");
  expect(inspect).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "agent": {
          "description": "Triage support tickets",
          "name": "Claude Code",
          "url": "https://example.com/agent",
        },
        "expires_at_millis": <stripped field 'expires_at_millis'>,
        "status": "pending",
        "user_hint": "alice@example.com",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Human-typed variants of the code are accepted.
  const lowerCaseNoDash = registration.claim_code.toLowerCase().replace("-", " ");
  const approve = await confirmAgent(lowerCaseNoDash, "approve");
  expect(approve.status).toBe(200);
  expect(approve.body.status).toBe("approved");

  const poll = await pollAgent(registration.poll_token);
  expect(poll.status).toBe(201);
  expect(poll.body.status).toBe("approved");
  expect(poll.body.session.user_id).toBe(user.userId);
  expect(poll.body.session.refresh_token).not.toBe(user.refreshToken);

  // The agent's tokens work as a normal session for the approving user.
  const agentAuth = { accessToken: poll.body.session.access_token, refreshToken: poll.body.session.refresh_token };
  const me = await niceBackendFetch("/api/v1/users/me", { accessType: "client", userAuth: agentAuth });
  expect(me.status).toBe(200);
  expect(me.body.id).toBe(user.userId);

  // Handing over the real session ends the pre-approval anonymous one.
  const anonymousRefresh = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
    method: "POST",
    accessType: "client",
    userAuth: { refreshToken: registration.anonymous_session.refresh_token },
  });
  expect(anonymousRefresh.status).toBe(401);

  const sessions = await niceBackendFetch(`/api/v1/auth/sessions?user_id=${user.userId}`, { accessType: "server" });
  expect(sessions.status).toBe(200);
  const agentNames = sessions.body.items.map((s: { agent_name: string | null }) => s.agent_name);
  expect(agentNames).toHaveLength(2);
  expect(agentNames).toContain(null);
  expect(agentNames).toContain("Claude Code");

  // Second poll cannot retrieve the session again.
  const secondPoll = await pollAgent(registration.poll_token);
  expect(secondPoll).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "status": "used" },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // The claim code is spent too.
  const reapprove = await confirmAgent(registration.claim_code, "approve");
  expect(reapprove.status).toBe(400);
  expect(reapprove.body.code).toBe("AGENT_AUTH_INVALID_CLAIM_CODE");
});

it("revoking the agent session signs out the agent but not the human", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body: registration } = await registerAgent();
  const user = await Auth.fastSignUp();
  await confirmAgent(registration.claim_code, "approve");
  const poll = await pollAgent(registration.poll_token);
  const agentAuth = { accessToken: poll.body.session.access_token, refreshToken: poll.body.session.refresh_token };

  const sessions = await niceBackendFetch(`/api/v1/auth/sessions?user_id=${user.userId}`, { accessType: "server" });
  const agentSession = sessions.body.items.find((s: { agent_name: string | null }) => s.agent_name === "Claude Code");
  expect(agentSession).toBeDefined();

  const revoke = await niceBackendFetch(`/api/v1/auth/sessions/${agentSession.id}?user_id=${user.userId}`, { method: "DELETE", accessType: "server" });
  expect(revoke.status).toBe(200);

  const agentRefresh = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
    method: "POST",
    accessType: "client",
    userAuth: { refreshToken: agentAuth.refreshToken },
  });
  expect(agentRefresh.status).toBe(401);

  const humanMe = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(humanMe.status).toBe(200);
});

it("revoking the agent session before the first poll reports expired and never hands out the dead session", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body: registration } = await registerAgent();
  const user = await Auth.fastSignUp();
  await confirmAgent(registration.claim_code, "approve");

  const sessions = await niceBackendFetch(`/api/v1/auth/sessions?user_id=${user.userId}`, { accessType: "server" });
  const agentSession = sessions.body.items.find((s: { agent_name: string | null }) => s.agent_name === "Claude Code");
  expect(agentSession).toBeDefined();
  const revoke = await niceBackendFetch(`/api/v1/auth/sessions/${agentSession.id}?user_id=${user.userId}`, { method: "DELETE", accessType: "server" });
  expect(revoke.status).toBe(200);

  const poll = await pollAgent(registration.poll_token);
  expect(poll).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "status": "expired" },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // The attempt is consumed; it does not flip back to approved on later polls.
  const secondPoll = await pollAgent(registration.poll_token);
  expect(secondPoll.body.status).toBe("used");
});

it("denying tells the poller, spends the claim code and revokes the anonymous session", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body: registration } = await registerAgent();
  const anonymousRefresh = { refreshToken: registration.anonymous_session.refresh_token };
  const refreshBeforeDeny = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
    method: "POST",
    accessType: "client",
    userAuth: anonymousRefresh,
  });
  expect(refreshBeforeDeny.status).toBe(200);
  await Auth.fastSignUp();

  const deny = await confirmAgent(registration.claim_code, "deny");
  expect(deny.status).toBe(200);
  expect(deny.body.status).toBe("denied");

  const poll = await pollAgent(registration.poll_token);
  expect(poll.body).toEqual({ status: "denied" });

  const approveAfterDeny = await confirmAgent(registration.claim_code, "approve");
  expect(approveAfterDeny.body.code).toBe("AGENT_AUTH_INVALID_CLAIM_CODE");

  const refreshAfterDeny = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
    method: "POST",
    accessType: "client",
    userAuth: anonymousRefresh,
  });
  expect(refreshAfterDeny.status).toBe(401);
});

it("honours a custom registration lifetime within the allowed bounds", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body: registration } = await registerAgent({ expires_in_millis: 30_000 });
  expect(registration.expires_at_millis - Date.now()).toBeLessThanOrEqual(30_000);
  expect(registration.expires_at_millis - Date.now()).toBeGreaterThan(20_000);

  const tooShort = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Claude Code" }, expires_in_millis: 1000 },
  });
  expect(tooShort.status).toBe(400);
  expect(tooShort.body.code).toBe("SCHEMA_ERROR");
});

it("requires a signed-in, non-anonymous human to confirm", async ({ expect }) => {
  await createProjectWithAgentAuth();
  const { body: registration } = await registerAgent();

  backendContext.set({ userAuth: null });
  const noUser = await confirmAgent(registration.claim_code, "approve");
  expect(noUser).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/agent/register/confirm:
              - auth.user must be defined
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/agent/register/confirm:
            - auth.user must be defined
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);

  // The agent's own anonymous session must not be able to approve itself.
  const selfApprove = await niceBackendFetch("/api/v1/agent/register/confirm", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken: registration.anonymous_session.access_token, refreshToken: registration.anonymous_session.refresh_token },
    headers: { "x-stack-allow-anonymous-user": "true" },
    body: { claim_code: registration.claim_code, action: "approve" },
  });
  expect(selfApprove.status).toBe(401);
  expect(selfApprove.body.code).toBe("ANONYMOUS_AUTHENTICATION_NOT_ALLOWED");

  const poll = await pollAgent(registration.poll_token);
  expect(poll.body).toEqual({ status: "pending" });
});

it("rejects an unknown claim code", async ({ expect }) => {
  await createProjectWithAgentAuth();
  await Auth.fastSignUp();
  const response = await confirmAgent("ZZZZ-ZZZZ", "inspect");
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "AGENT_AUTH_INVALID_CLAIM_CODE",
        "error": "The claim code is invalid, has expired, or has already been used.",
      },
      "headers": Headers {
        "x-stack-known-error": "AGENT_AUTH_INVALID_CLAIM_CODE",
        <some fields may have been hidden>,
      },
    }
  `);
});
