import { it } from "../../../../../helpers";
import { Auth, niceBackendFetch, Project } from "../../../../backend-helpers";

it("requires admin access", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/internal/agent-auth", { accessType: "client" });
  expect(response.status).toBe(401);
  expect(response.body.code).toBe("INSUFFICIENT_ACCESS_TYPE");
});

it("lists recent registrations and active agent sessions without leaking secrets", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });

  const empty = await niceBackendFetch("/api/v1/internal/agent-auth", { accessType: "admin" });
  expect(empty).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "agent_sessions": [],
        "recent_attempts": [],
        "summary": {
          "active_agent_sessions_in_window": 0,
          "agent_session_window_limit": 200,
          "attempt_window_limit": 50,
          "attempts_in_window": 0,
          "denied_attempts_in_window": 0,
          "expired_attempts_in_window": 0,
          "pending_attempts_in_window": 0,
          "used_attempts_in_window": 0,
        },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const pending = await niceBackendFetch("/api/v1/agent/register", {
    method: "POST",
    accessType: "client",
    body: { agent: { name: "Pending Bot" } },
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

  const response = await niceBackendFetch("/api/v1/internal/agent-auth", { accessType: "admin" });
  expect(response.status).toBe(200);
  expect(response.body.summary).toMatchInlineSnapshot(`
    {
      "active_agent_sessions_in_window": 2,
      "agent_session_window_limit": 200,
      "attempt_window_limit": 50,
      "attempts_in_window": 3,
      "denied_attempts_in_window": 1,
      "expired_attempts_in_window": 0,
      "pending_attempts_in_window": 1,
      "used_attempts_in_window": 1,
    }
  `);
  const statuses = Object.fromEntries(response.body.recent_attempts.map((a: { agent_name: string, status: string }) => [a.agent_name, a.status]));
  expect(statuses).toEqual({ "Pending Bot": "pending", "Approved Bot": "used", "Denied Bot": "denied" });
  // Every registration mints an anonymous session tagged with the agent name (so it is visible and revocable
  // from day one). Approval mints a non-anonymous one on the approver's account, and the anonymous one is
  // revoked the moment the agent polls it; denial revokes the anonymous one too. So: pending (1) + approved
  // and polled (1) + denied (0).
  expect(response.body.agent_sessions).toHaveLength(2);
  const approvedSessions = response.body.agent_sessions.filter((s: { user_id: string }) => s.user_id === user.userId);
  expect(approvedSessions).toHaveLength(1);
  expect(approvedSessions[0].agent_name).toBe("Approved Bot");
  expect(approvedSessions[0].is_expired).toBe(false);

  const serialized = JSON.stringify(response.body);
  for (const secret of [pending.body.poll_token, pending.body.claim_code, approvedRegistration.body.poll_token]) {
    expect(serialized).not.toContain(secret);
  }
});
