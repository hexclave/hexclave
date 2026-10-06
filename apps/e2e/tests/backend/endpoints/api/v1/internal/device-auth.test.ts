import { it } from "../../../../../helpers";
import { Auth, niceBackendFetch, Project } from "../../../../backend-helpers";

it("requires admin access", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/internal/device-auth?kind=agent", { accessType: "client" });
  expect(response.status).toBe(401);
  expect(response.body.code).toBe("INSUFFICIENT_ACCESS_TYPE");
});

it("rejects an unknown kind", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/internal/device-auth?kind=nope", { accessType: "admin" });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("SCHEMA_ERROR");
});

it("returns bounded CLI metrics without exposing login secrets", async ({ expect }) => {
  await Project.createAndSwitch();

  const createdAttempt = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {},
  });
  expect(createdAttempt.status).toBe(200);

  const response = await niceBackendFetch("/api/latest/internal/device-auth?kind=cli", { accessType: "admin" });
  expect(response.status).toBe(200);
  expect(response.body.summary).toMatchInlineSnapshot(`
    {
      "active_sessions_in_window": 0,
      "attempt_window_limit": 50,
      "attempts_in_window": 1,
      "denied_attempts_in_window": 0,
      "expired_attempts_in_window": 0,
      "session_window_limit": 200,
      "success_attempts_in_window": 0,
      "used_attempts_in_window": 0,
      "waiting_attempts_in_window": 1,
    }
  `);
  expect(response.body.recent_attempts).toHaveLength(1);
  expect(response.body.recent_attempts[0]).toMatchObject({ status: "waiting", used_at: null, agent: null });
  expect(response.body.sessions).toEqual([]);
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toContain(createdAttempt.body.polling_code);
  expect(serialized).not.toContain(createdAttempt.body.login_code);
});

it("returns used CLI attempts with their active sessions", async ({ expect }) => {
  await Project.createAndSwitch();
  const user = await Auth.fastSignUp();

  const createdAttempt = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {},
  });
  const completedAttempt = await niceBackendFetch("/api/latest/auth/cli/complete", {
    method: "POST",
    accessType: "server",
    body: {
      login_code: createdAttempt.body.login_code,
      mode: "complete",
      refresh_token: user.refreshToken,
    },
  });
  expect(completedAttempt.status).toBe(200);

  const polledAttempt = await niceBackendFetch("/api/latest/auth/cli/poll", {
    method: "POST",
    accessType: "server",
    body: { polling_code: createdAttempt.body.polling_code },
  });
  expect(polledAttempt.status).toBe(201);

  const response = await niceBackendFetch("/api/latest/internal/device-auth?kind=cli", { accessType: "admin" });
  expect(response.status).toBe(200);
  expect(response.body.summary.active_sessions_in_window).toBe(1);
  expect(response.body.summary.used_attempts_in_window).toBe(1);
  expect(response.body.recent_attempts[0].status).toBe("used");
  expect(response.body.sessions).toHaveLength(1);
  expect(response.body.sessions[0]).toMatchObject({ user_id: user.userId, agent_name: null, is_expired: false });
  expect(JSON.stringify(response.body)).not.toContain(polledAttempt.body.refresh_token);
});

it("keeps CLI and agent attempts apart", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });

  await niceBackendFetch("/api/latest/auth/cli", { method: "POST", accessType: "server", body: {} });
  await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Some Bot" } },
  });

  const cli = await niceBackendFetch("/api/latest/internal/device-auth?kind=cli", { accessType: "admin" });
  const agent = await niceBackendFetch("/api/latest/internal/device-auth?kind=agent", { accessType: "admin" });
  expect(cli.body.recent_attempts.map((a: { agent: unknown }) => a.agent)).toEqual([null]);
  expect(agent.body.recent_attempts.map((a: { agent: { name: string } }) => a.agent.name)).toEqual(["Some Bot"]);
});

it("lists agent registrations and active agent sessions without leaking secrets", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });

  const empty = await niceBackendFetch("/api/v1/internal/device-auth?kind=agent", { accessType: "admin" });
  expect(empty).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "recent_attempts": [],
        "sessions": [],
        "summary": {
          "active_sessions_in_window": 0,
          "attempt_window_limit": 50,
          "attempts_in_window": 0,
          "denied_attempts_in_window": 0,
          "expired_attempts_in_window": 0,
          "session_window_limit": 200,
          "success_attempts_in_window": 0,
          "used_attempts_in_window": 0,
          "waiting_attempts_in_window": 0,
        },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const waiting = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Waiting Bot" } },
  });
  const approvedRegistration = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Approved Bot", description: "Does things" } },
  });
  const deniedRegistration = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Denied Bot" } },
  });
  const user = await Auth.fastSignUp();
  await niceBackendFetch("/api/v1/agent/register/confirm", {
    method: "POST",
    accessType: "client",
    body: { claim_code: approvedRegistration.body.claim_code, action: "approve" },
  });
  await niceBackendFetch("/api/v1/agent/register/confirm", {
    method: "POST",
    accessType: "client",
    body: { claim_code: deniedRegistration.body.claim_code, action: "deny" },
  });
  await niceBackendFetch("/api/v1/agent/register/poll", {
    method: "POST",
    accessType: "client",
    body: { poll_token: approvedRegistration.body.poll_token },
  });

  const response = await niceBackendFetch("/api/v1/internal/device-auth?kind=agent", { accessType: "admin" });
  expect(response.status).toBe(200);
  expect(response.body.summary).toMatchInlineSnapshot(`
    {
      "active_sessions_in_window": 2,
      "attempt_window_limit": 50,
      "attempts_in_window": 3,
      "denied_attempts_in_window": 1,
      "expired_attempts_in_window": 0,
      "session_window_limit": 200,
      "success_attempts_in_window": 0,
      "used_attempts_in_window": 1,
      "waiting_attempts_in_window": 1,
    }
  `);
  const statuses = Object.fromEntries(response.body.recent_attempts.map((a: { agent: { name: string }, status: string }) => [a.agent.name, a.status]));
  expect(statuses).toEqual({ "Waiting Bot": "waiting", "Approved Bot": "used", "Denied Bot": "denied" });
  // Every registration mints an anonymous session tagged with the agent name (so it is visible and revocable
  // from day one). Approval mints a non-anonymous one on the approver's account, and the anonymous one is
  // revoked the moment the agent polls it; denial revokes the anonymous one too. So: waiting (1) + approved
  // and polled (1) + denied (0).
  expect(response.body.sessions).toHaveLength(2);
  const approvedSessions = response.body.sessions.filter((s: { user_id: string }) => s.user_id === user.userId);
  expect(approvedSessions).toHaveLength(1);
  expect(approvedSessions[0]).toMatchObject({ agent_name: "Approved Bot", is_anonymous: false, is_expired: false });

  const serialized = JSON.stringify(response.body);
  for (const secret of [waiting.body.poll_token, waiting.body.claim_code, approvedRegistration.body.poll_token]) {
    expect(serialized).not.toContain(secret);
  }
});
