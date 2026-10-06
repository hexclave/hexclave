import { it } from "../../../../../helpers";
import { backendContext, niceBackendFetch, Project } from "../../../../backend-helpers";

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

it("serves discovery and auth.md with only the project ID header, so an agent can bootstrap from the dashboard prompt", async ({ expect }) => {
  await Project.createAndSwitch({ display_name: "Bootstrap Project" });
  await Project.updateConfig({ "apps.installed.agent-auth.enabled": true });
  const projectKeys = backendContext.value.projectKeys;
  if (projectKeys === "no-project") throw new Error("expected a project");

  const discovery = await niceBackendFetch("/api/v1/agent/discovery", {
    accessType: null,
    headers: { "x-hexclave-project-id": projectKeys.projectId },
  });
  expect(discovery.status).toBe(200);
  expect(discovery.body.hexclave_agent_auth.project_id).toBe(projectKeys.projectId);
  expect(discovery.body.hexclave_agent_auth.publishable_client_key).toBe(null);
  // New projects don't enforce the publishable key, so agents shouldn't be told to send one they can't know
  expect(discovery.body.hexclave_agent_auth.publishable_client_key_required).toBe(false);
  expect(discovery.body.hexclave_agent_auth.required_headers).toEqual({
    "x-hexclave-access-type": "client",
    "x-hexclave-project-id": projectKeys.projectId,
  });

  const markdown = await niceBackendFetch("/api/v1/agent/auth.md", {
    accessType: null,
    headers: { "x-hexclave-project-id": projectKeys.projectId },
  });
  expect(markdown.status).toBe(200);
  expect(markdown.body).toContain("# Agent authentication for Bootstrap Project");
  expect(markdown.body).not.toContain("publishable client key");
});

it("lists the publishable key header (with a placeholder) only when the project enforces it", async ({ expect }) => {
  await Project.createAndSwitch();
  await Project.updateProjectConfig({ "project.requirePublishableClientKey": true });
  const projectKeys = backendContext.value.projectKeys;
  if (projectKeys === "no-project") throw new Error("expected a project");

  const discovery = await niceBackendFetch("/api/v1/agent/discovery", {
    accessType: null,
    headers: { "x-hexclave-project-id": projectKeys.projectId },
  });
  expect(discovery.status).toBe(200);
  expect(discovery.body.hexclave_agent_auth.publishable_client_key_required).toBe(true);
  expect(discovery.body.hexclave_agent_auth.required_headers["x-hexclave-publishable-client-key"]).toContain("<publishable client key");

  const withKey = await niceBackendFetch("/api/v1/agent/discovery", { accessType: "client" });
  expect(withKey.body.hexclave_agent_auth.required_headers["x-hexclave-publishable-client-key"]).toBe(projectKeys.publishableClientKey);
});

it("rejects discovery without a project ID or with an unknown project", async ({ expect }) => {
  const missing = await niceBackendFetch("/api/v1/agent/discovery", { accessType: null });
  expect(missing.status).toBe(400);
  expect(missing.body).toContain("x-hexclave-project-id");

  const unknown = await niceBackendFetch("/api/v1/agent/discovery", {
    accessType: null,
    headers: { "x-hexclave-project-id": "does-not-exist" },
  });
  expect(unknown.status).toBe(400);
  expect(unknown.body.code).toBe("CURRENT_PROJECT_NOT_FOUND");
});

it("auth.md tells agents when the project has not enabled agent auth", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/agent/auth.md", { accessType: "client" });
  expect(response.status).toBe(200);
  expect(response.body).toContain("not enabled");
});
