import { it } from "../../../../../helpers";
import { niceBackendFetch, Project } from "../../../../backend-helpers";

it("serves a machine-readable discovery document that reflects whether agent auth is enabled", async ({ expect }) => {
  await Project.createAndSwitch();

  const disabled = await niceBackendFetch("/api/v1/agent/discovery", { accessType: "client" });
  expect(disabled.status).toBe(200);
  expect(disabled.body.hexclave_agent_auth.enabled).toBe(false);
  expect(disabled.body.registration_endpoint).toMatch(/\/api\/v1\/agent\/register$/);
  expect(disabled.body.hexclave_agent_auth.poll_endpoint).toMatch(/\/api\/v1\/agent\/register\/poll$/);
  expect(disabled.body.hexclave_agent_auth.confirm_endpoint).toMatch(/\/api\/v1\/agent\/register\/confirm$/);
  expect(disabled.body.agent_auth_md).toMatch(/\/api\/v1\/agent\/auth\.md$/);
  expect(disabled.body.hexclave_agent_auth.claim_code_format).toMatchInlineSnapshot(`"XXXX-XXXX (A-Z and 2-9, no 0/O/1/I)"`);
  expect(typeof disabled.body.hexclave_agent_auth.publishable_client_key).toBe("string");

  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });
  const enabled = await niceBackendFetch("/api/v1/agent/discovery", { accessType: "client" });
  expect(enabled.body.hexclave_agent_auth.enabled).toBe(true);
});

it("serves auth.md as project-specific Markdown with the publishable key and endpoints filled in", async ({ expect }) => {
  await Project.createAndSwitch({ display_name: "Agent Md Test Project" });
  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });

  const response = await niceBackendFetch("/api/v1/agent/auth.md", { accessType: "client" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/markdown/);
  const markdown: string = response.body;
  expect(markdown.startsWith("# Agent authentication for Agent Md Test Project")).toBe(true);
  expect(markdown).toContain("/api/v1/agent/register");
  expect(markdown).toContain("/api/v1/agent/register/poll");
  expect(markdown).toContain("x-hexclave-publishable-client-key");
  expect(markdown).toContain("x-hexclave-allow-anonymous-user");
  expect(markdown).not.toContain("<publishable client key>");
});

it("auth.md tells agents when the project has not enabled agent auth", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/agent/auth.md", { accessType: "client" });
  expect(response.status).toBe(200);
  expect(response.body).toContain("not enabled");
});
