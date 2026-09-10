import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../../helpers";
import { Auth, InternalApiKey, Payments, Project, backendContext, bumpEmailAddress, niceBackendFetch } from "../../../../backend-helpers";

async function listAuditLog(options?: { action?: string, targetUserId?: string, cursor?: string, limit?: number }) {
  return await niceBackendFetch("/api/v1/internal/audit-log", {
    method: "GET",
    accessType: "admin",
    query: {
      ...(options?.action != null ? { action: options.action } : {}),
      ...(options?.targetUserId != null ? { target_user_id: options.targetUserId } : {}),
      ...(options?.cursor != null ? { cursor: options.cursor } : {}),
      ...(options?.limit != null ? { limit: String(options.limit) } : {}),
    },
  });
}

/** Project.createAndSwitch mints project API keys, which now write project_api_key.created. */
function withoutProjectBootstrapEvents(items: Array<{ action: string }>) {
  return items.filter((item) => item.action !== "project_api_key.created");
}

it("lists admin audit events without requiring Compliance app", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  const res = await listAuditLog();
  expect(res.status).toBe(200);
  expect(withoutProjectBootstrapEvents(res.body.items)).toEqual([]);
});

it("always writes impersonation events without enabling any app", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const signUp = await Auth.Password.signUpWithEmail();

  // Compliance audits are dashboard-only — impersonation must use admin + admin access token.
  const impersonation = await niceBackendFetch("/api/v1/auth/sessions", {
    accessType: "admin",
    method: "POST",
    body: {
      user_id: signUp.userId,
      is_impersonation: true,
      reason: "always on",
    },
  });
  expect(impersonation.status).toBe(200);

  const listRes = await listAuditLog({ action: "impersonation.started" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toHaveLength(1);
  expect(listRes.body.items[0]).toMatchObject({
    action: "impersonation.started",
    actor_type: "admin_user",
    target_user_id: signUp.userId,
    reason: "always on",
  });
});

it("records impersonation started with reason and actor", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const signUp = await Auth.Password.signUpWithEmail();

  const impersonation = await niceBackendFetch("/api/v1/auth/sessions", {
    accessType: "admin",
    method: "POST",
    body: {
      user_id: signUp.userId,
      is_impersonation: true,
      reason: " Investigating billing issue ",
    },
  });
  expect(impersonation.status).toBe(200);

  const listRes = await listAuditLog({ action: "impersonation.started" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toHaveLength(1);
  expect(listRes.body.items[0]).toMatchObject({
    action: "impersonation.started",
    actor_type: "admin_user",
    actor_user_id: expect.any(String),
    target_user_id: signUp.userId,
    reason: "Investigating billing issue",
  });
  expect(listRes.body.items[0].metadata).toMatchObject({
    source: "auth.sessions",
  });
  expect(typeof listRes.body.items[0].metadata.refresh_token_id).toBe("string");
});

it("does not audit impersonation started via server API key alone", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const signUp = await Auth.Password.signUpWithEmail();

  const impersonation = await niceBackendFetch("/api/v1/auth/sessions", {
    accessType: "server",
    method: "POST",
    body: {
      user_id: signUp.userId,
      is_impersonation: true,
      reason: "server key only",
    },
  });
  expect(impersonation.status).toBe(200);

  const listRes = await listAuditLog({ action: "impersonation.started" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toEqual([]);
});

it("records impersonation revoked when an impersonation session is deleted", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const signUp = await Auth.Password.signUpWithEmail();

  const impersonation = await niceBackendFetch("/api/v1/auth/sessions", {
    accessType: "admin",
    method: "POST",
    body: {
      user_id: signUp.userId,
      is_impersonation: true,
      reason: "support",
    },
  });
  expect(impersonation.status).toBe(200);

  const sessions = await niceBackendFetch("/api/v1/auth/sessions", {
    accessType: "admin",
    method: "GET",
    query: {
      user_id: signUp.userId,
    },
  });
  expect(sessions.status).toBe(200);
  const impersonationSession = sessions.body.items.find((session: { is_impersonation: boolean }) => session.is_impersonation);
  expect(impersonationSession).toBeDefined();

  const revoke = await niceBackendFetch(`/api/v1/auth/sessions/${impersonationSession.id}`, {
    accessType: "admin",
    method: "DELETE",
    query: {
      user_id: signUp.userId,
    },
  });
  expect(revoke.status).toBe(200);

  const listRes = await listAuditLog({ action: "impersonation.revoked" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toHaveLength(1);
  expect(listRes.body.items[0]).toMatchObject({
    action: "impersonation.revoked",
    target_user_id: signUp.userId,
    actor_type: "admin_user",
    actor_user_id: expect.any(String),
  });
});

it("ignores reason on non-impersonation session creation", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const signUp = await Auth.Password.signUpWithEmail();

  const session = await niceBackendFetch("/api/v1/auth/sessions", {
    accessType: "admin",
    method: "POST",
    body: {
      user_id: signUp.userId,
      is_impersonation: false,
      reason: "not an impersonation",
    },
  });
  expect(session.status).toBe(200);

  const listRes = await listAuditLog();
  expect(listRes.status).toBe(200);
  expect(withoutProjectBootstrapEvents(listRes.body.items)).toEqual([]);
});

it("records project settings config updates with non-sensitive before/after values", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  // Establish a known before value — defaults/create may already set this true.
  await Project.updateConfig({ "auth.password.allowSignIn": false });
  await Project.updateConfig({ "auth.password.allowSignIn": true });

  const listRes = await listAuditLog({ action: "project_settings.updated" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items.length).toBeGreaterThanOrEqual(2);
  expect(listRes.body.items[0]).toMatchObject({
    action: "project_settings.updated",
    target_user_id: null,
    actor_type: "admin_user",
    actor_user_id: expect.any(String),
  });
  expect(listRes.body.items[0].metadata).toMatchObject({
    source: "config.override.patch",
    level: "environment",
    write_mode: "merge",
    changes: {
      "auth.password.allowSignIn": {
        before: false,
        after: true,
      },
    },
  });
  expect(listRes.body.items[0].metadata.changed_paths).toContain("auth.password.allowSignIn");
  expect(listRes.body.items[0].metadata.changed_paths.every((path: unknown) => typeof path === "string")).toBe(true);
});

it("records project metadata updates from projects/current with before/after", async ({ expect }) => {
  const created = await Project.createAndSwitch({
    display_name: "Original Project Name",
    config: { magic_link_enabled: true },
  });
  expect(created.createProjectResponse.body.display_name).toBe("Original Project Name");

  const update = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
    method: "PATCH",
    body: {
      display_name: "Audited Project Name",
    },
  });
  expect(update.status).toBe(200);

  const listRes = await listAuditLog({ action: "project_settings.updated" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toHaveLength(1);
  expect(listRes.body.items[0]).toMatchObject({
    action: "project_settings.updated",
    target_user_id: null,
    metadata: {
      source: "projects.current.update",
      write_mode: "merge",
      changed_paths: ["display_name"],
      changes: {
        display_name: {
          before: "Original Project Name",
          after: "Audited Project Name",
        },
      },
    },
  });
});

it("does not persist values for sensitive config leaves", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  await Project.updateConfig({
    "emails.server": {
      isShared: false,
      provider: "smtp",
      host: "smtp.example.com",
      port: 587,
      username: "mailer",
      password: "super-secret-password",
      senderName: "Example",
      senderEmail: "noreply@example.com",
    },
  });

  const listRes = await listAuditLog({ action: "project_settings.updated" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toHaveLength(1);
  const event = listRes.body.items[0];
  expect(event.metadata.changed_paths).toContain("emails.server.password");
  // Sensitive leaf: path is recorded, before/after are not.
  expect(event.metadata.changes?.["emails.server.password"]).toBeUndefined();
  // Non-sensitive sibling leaves still get values.
  expect(event.metadata.changes?.["emails.server.host"]).toMatchObject({
    after: "smtp.example.com",
  });
  expect(JSON.stringify(event.metadata)).not.toContain("super-secret-password");
});

it("records config source unlink with previous GitHub identity", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  await Project.pushConfig({}, {
    type: "pushed-from-github",
    owner: "audit-org",
    repo: "audit-repo",
    branch: "main",
    commit_hash: "abc123def456",
    config_file_path: "hexclave.config.ts",
  });

  await Project.unlinkConfigSource();

  const listRes = await listAuditLog({ action: "config_source.unlinked" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toHaveLength(1);
  expect(listRes.body.items[0]).toMatchObject({
    action: "config_source.unlinked",
    target_user_id: null,
    metadata: {
      source: "config.source.delete",
      changed_paths: expect.arrayContaining([
        "type",
        "owner",
        "repo",
        "branch",
        "config_file_path",
      ]),
      changes: {
        type: {
          before: "pushed-from-github",
          after: "unlinked",
        },
        owner: {
          before: "audit-org",
          after: null,
        },
        repo: {
          before: "audit-repo",
          after: null,
        },
      },
    },
  });
});

it("audits oauth provider enable/disable without empty shared-schema noise", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  await Project.updateConfig({
    "auth.oauth.providers.google": {
      type: "google",
      isShared: true,
      allowSignIn: true,
      allowConnectedAccounts: true,
    },
  });
  await Project.updateConfig({
    "auth.oauth.providers.linkedin": {
      type: "linkedin",
      isShared: false,
      clientId: "linkedin-client-id",
      clientSecret: "linkedin-client-secret",
      // Shared provider-bag leftovers the Auth Methods form can send as "".
      facebookConfigId: "",
      microsoftTenantId: "",
      allowSignIn: true,
      allowConnectedAccounts: true,
    },
  });
  await Project.updateConfig({
    "auth.oauth.providers.google": null,
  });

  const listRes = await listAuditLog({ action: "project_settings.updated" });
  expect(listRes.status).toBe(200);

  // Whole-provider enable collapses to one summary row (same shape as disable).
  const linkedinEnable = listRes.body.items.find((item: { metadata?: { changed_paths?: string[] } }) => (
    item.metadata?.changed_paths?.includes("auth.oauth.providers.linkedin")
  ));
  expect(linkedinEnable).toMatchObject({
    action: "project_settings.updated",
    metadata: {
      changed_paths: ["auth.oauth.providers.linkedin"],
      changes: {
        "auth.oauth.providers.linkedin": {
          before: null,
          after: "linkedin",
        },
      },
    },
  });
  expect(JSON.stringify(linkedinEnable.metadata)).not.toContain("linkedin-client-secret");
  expect(JSON.stringify(linkedinEnable.metadata)).not.toContain("facebookConfigId");

  const googleDisable = listRes.body.items.find((item: { metadata?: { changed_paths?: string[] } }) => (
    item.metadata?.changed_paths?.includes("auth.oauth.providers.google")
  ));
  expect(googleDisable).toMatchObject({
    action: "project_settings.updated",
    metadata: {
      changed_paths: ["auth.oauth.providers.google"],
      changes: {
        "auth.oauth.providers.google": {
          before: "google",
          after: null,
        },
      },
    },
  });
});

it("audits shared→standard oauth key switch with only real field diffs", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  await Project.updateConfig({
    "auth.oauth.providers.github": {
      type: "github",
      isShared: true,
      allowSignIn: true,
      allowConnectedAccounts: true,
    },
  });

  await Project.updateConfig({
    "auth.oauth.providers.github": {
      type: "github",
      isShared: false,
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      customCallbackUrl: "http://localhost:8102/api/v1/auth/oauth/callback/github",
      // Unchanged flags — must not appear as Yes→Yes in the audit.
      allowSignIn: true,
      allowConnectedAccounts: true,
      facebookConfigId: "",
      microsoftTenantId: "",
    },
  });

  const listRes = await listAuditLog({ action: "project_settings.updated" });
  expect(listRes.status).toBe(200);
  const keySwitch = listRes.body.items.find((item: { metadata?: { changes?: { "auth.oauth.providers.github.isShared"?: unknown } } }) => (
    item.metadata?.changes?.["auth.oauth.providers.github.isShared"] != null
  ));
  expect(keySwitch).toBeDefined();
  expect(keySwitch.metadata.changed_paths).toEqual(expect.arrayContaining([
    "auth.oauth.providers.github.isShared",
    "auth.oauth.providers.github.clientId",
    "auth.oauth.providers.github.clientSecret",
    "auth.oauth.providers.github.customCallbackUrl",
  ]));
  expect(keySwitch.metadata.changed_paths).not.toContain("auth.oauth.providers.github.allowSignIn");
  expect(keySwitch.metadata.changed_paths).not.toContain("auth.oauth.providers.github.allowConnectedAccounts");
  expect(keySwitch.metadata.changed_paths).not.toContain("auth.oauth.providers.github.facebookConfigId");
  expect(keySwitch.metadata.changes?.["auth.oauth.providers.github.isShared"]).toMatchObject({
    before: true,
    after: false,
  });
  expect(keySwitch.metadata.changes?.["auth.oauth.providers.github.allowSignIn"]).toBeUndefined();
  expect(JSON.stringify(keySwitch.metadata)).not.toContain("gh-client-secret");
});

it("does not audit end-user password signup (programmatic user create)", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.Password.signUpWithEmail();

  const listRes = await listAuditLog();
  expect(listRes.status).toBe(200);
  expect(withoutProjectBootstrapEvents(listRes.body.items)).toEqual([]);
  expect(listRes.body.items.some((item: { action: string }) => item.action === "user.created")).toBe(false);
});

it("records Authentication user-directory admin actions", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  const created = await niceBackendFetch("/api/v1/users", {
    accessType: "admin",
    method: "POST",
    body: {
      primary_email: "audited-user@example.com",
      primary_email_verified: true,
      // Password-reset lookup only finds contact channels with used_for_auth.
      primary_email_auth_enabled: true,
      password: "password123",
      display_name: "Audited User",
    },
  });
  expect(created.status).toBe(201);
  const userId = created.body.id as string;

  const restrict = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      restricted_by_admin: true,
      restricted_by_admin_reason: "Suspicious activity",
    },
  });
  expect(restrict.status).toBe(200);

  const setPassword = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      password: "new-password-456",
    },
  });
  expect(setPassword.status).toBe(200);

  const enableMfa = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      totp_secret_base64: "ZXhhbXBsZSB2YWx1ZQ==",
    },
  });
  expect(enableMfa.status).toBe(200);

  const removeMfa = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      totp_secret_base64: null,
    },
  });
  expect(removeMfa.status).toBe(200);

  const updateProfile = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      display_name: "Renamed Audited User",
    },
  });
  expect(updateProfile.status).toBe(200);

  const unrestrict = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      restricted_by_admin: false,
    },
  });
  expect(unrestrict.status).toBe(200);

  const contactChannel = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "admin",
    method: "POST",
    body: {
      user_id: userId,
      type: "email",
      value: "secondary-audit@example.com",
      is_verified: false,
      used_for_auth: false,
    },
  });
  expect(contactChannel.status).toBe(201);
  const contactChannelId = contactChannel.body.id as string;

  const updateChannel = await niceBackendFetch(`/api/v1/contact-channels/${userId}/${contactChannelId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      used_for_auth: false,
      is_primary: false,
    },
  });
  expect(updateChannel.status).toBe(200);

  const sendVerification = await niceBackendFetch(`/api/v1/contact-channels/${userId}/${contactChannelId}/send-verification-code`, {
    accessType: "admin",
    method: "POST",
    body: {
      callback_url: "http://localhost:12345/some-callback-url",
    },
  });
  expect(sendVerification.status).toBe(200);

  const sendReset = await niceBackendFetch("/api/v1/auth/password/send-reset-code", {
    accessType: "admin",
    method: "POST",
    body: {
      email: "audited-user@example.com",
      callback_url: "http://localhost:12345/some-callback-url",
    },
  });
  expect(sendReset.status).toBe(200);

  const invitation = await niceBackendFetch("/api/v1/internal/send-sign-in-invitation", {
    accessType: "admin",
    method: "POST",
    body: {
      email: "invitee-audit@example.com",
      callback_url: "http://localhost:12345/some-callback-url",
    },
  });
  expect(invitation.status).toBe(200);

  const deleteChannel = await niceBackendFetch(`/api/v1/contact-channels/${userId}/${contactChannelId}`, {
    accessType: "admin",
    method: "DELETE",
  });
  expect(deleteChannel.status).toBe(200);

  const deleted = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "admin",
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);

  const listRes = await listAuditLog({ targetUserId: userId });
  expect(listRes.status).toBe(200);
  const actions = listRes.body.items.map((item: { action: string }) => item.action);
  expect(actions).toContain("user.created");
  expect(actions).toContain("user.restricted");
  expect(actions).toContain("user.password.set");
  expect(actions).toContain("user.mfa.enabled");
  expect(actions).toContain("user.mfa.removed");
  expect(actions).toContain("user.updated");
  expect(actions).toContain("user.unrestricted");
  expect(actions).toContain("contact_channel.created");
  expect(actions).toContain("contact_channel.updated");
  expect(actions).toContain("contact_channel.verification.sent");
  expect(actions).toContain("user.password_reset.sent");
  expect(actions).toContain("contact_channel.deleted");
  expect(actions).toContain("user.deleted");

  const createdEvent = listRes.body.items.find((item: { action: string }) => item.action === "user.created");
  expect(createdEvent.metadata.changed_paths).toEqual(expect.arrayContaining([
    "primary_email",
    "primary_email_verified",
    "display_name",
    "password",
  ]));
  expect(createdEvent.metadata.changes).toMatchObject({
    primary_email: { before: null, after: "audited-user@example.com" },
    display_name: { before: null, after: "Audited User" },
    primary_email_verified: { before: null, after: true },
  });
  // Password: path recorded, value never persisted.
  expect(createdEvent.metadata.changes?.password).toBeUndefined();
  expect(JSON.stringify(createdEvent.metadata)).not.toContain("password123");

  const updated = listRes.body.items.find((item: { action: string }) => item.action === "user.updated");
  expect(updated).toMatchObject({
    action: "user.updated",
    target_user_id: userId,
    metadata: {
      source: "users.update",
      changed_paths: ["display_name"],
      changes: {
        display_name: {
          before: "Audited User",
          after: "Renamed Audited User",
        },
      },
    },
  });

  const restricted = listRes.body.items.find((item: { action: string }) => item.action === "user.restricted");
  expect(restricted).toMatchObject({
    action: "user.restricted",
    target_user_id: userId,
    reason: "Suspicious activity",
  });

  const passwordSet = listRes.body.items.find((item: { action: string }) => item.action === "user.password.set");
  expect(JSON.stringify(passwordSet.metadata)).not.toContain("new-password-456");

  const invitationList = await listAuditLog({ action: "user.sign_in_invitation.sent" });
  expect(invitationList.status).toBe(200);
  expect(invitationList.body.items).toHaveLength(1);
  expect(invitationList.body.items[0]).toMatchObject({
    action: "user.sign_in_invitation.sent",
    target_user_id: null,
    metadata: {
      source: "send_sign_in_invitation",
    },
  });
  expect(JSON.stringify(invitationList.body.items[0].metadata)).not.toContain("invitee-audit@example.com");
});

it("does not audit client self-service password reset emails", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const signUp = await Auth.Password.signUpWithEmail();
  await Auth.signOut();

  const sendReset = await niceBackendFetch("/api/v1/auth/password/send-reset-code", {
    accessType: "client",
    method: "POST",
    body: {
      email: signUp.email,
      callback_url: "http://localhost:12345/some-callback-url",
    },
  });
  expect(sendReset.status).toBe(200);

  const listRes = await listAuditLog({ action: "user.password_reset.sent" });
  expect(listRes.status).toBe(200);
  expect(listRes.body.items).toEqual([]);
});

it("records project API key create, update, and revoke without persisting secrets", async ({ expect }) => {
  // createAndSwitch already mints a project key set for test auth — create a
  // second set with a distinct description so we can assert on that event.
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  const created = await InternalApiKey.create(undefined, {
    description: "Audited project key",
    has_publishable_client_key: true,
    has_secret_server_key: true,
    has_super_secret_admin_key: false,
  });
  const apiKeyId = created.createApiKeyResponse.body.id as string;
  const secretServerKey = created.createApiKeyResponse.body.secret_server_key as string;
  expect(typeof secretServerKey).toBe("string");

  const rename = await niceBackendFetch(`/api/v1/internal/api-keys/${apiKeyId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      description: "Renamed audited project key",
    },
  });
  expect(rename.status).toBe(200);

  const revoke = await niceBackendFetch(`/api/v1/internal/api-keys/${apiKeyId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      revoked: true,
    },
  });
  expect(revoke.status).toBe(200);

  const createdList = await listAuditLog({ action: "project_api_key.created" });
  expect(createdList.status).toBe(200);
  const createdEvent = createdList.body.items.find((item: { metadata?: { changes?: { description?: { after?: string } } } }) => (
    item.metadata?.changes?.description?.after === "Audited project key"
  ));
  expect(createdEvent).toMatchObject({
    action: "project_api_key.created",
    target_user_id: null,
    metadata: {
      source: "api_keys.create",
      changed_paths: expect.arrayContaining([
        "api_key_id",
        "description",
        "has_publishable_client_key",
        "has_secret_server_key",
      ]),
      changes: {
        description: { before: null, after: "Audited project key" },
        has_publishable_client_key: { before: null, after: true },
        has_secret_server_key: { before: null, after: true },
        has_super_secret_admin_key: { before: null, after: false },
      },
    },
  });
  expect(JSON.stringify(createdEvent.metadata)).not.toContain(secretServerKey);
  expect(JSON.stringify(createdEvent.metadata)).not.toContain("pck_");
  expect(JSON.stringify(createdEvent.metadata)).not.toContain("ssk_");

  const updatedList = await listAuditLog({ action: "project_api_key.updated" });
  expect(updatedList.status).toBe(200);
  expect(updatedList.body.items).toHaveLength(1);
  expect(updatedList.body.items[0]).toMatchObject({
    action: "project_api_key.updated",
    metadata: {
      source: "api_keys.update",
      api_key_id: apiKeyId,
      changed_paths: ["description"],
      changes: {
        description: {
          before: "Audited project key",
          after: "Renamed audited project key",
        },
      },
    },
  });

  const revokedList = await listAuditLog({ action: "project_api_key.revoked" });
  expect(revokedList.status).toBe(200);
  expect(revokedList.body.items).toHaveLength(1);
  expect(revokedList.body.items[0]).toMatchObject({
    action: "project_api_key.revoked",
    metadata: {
      source: "api_keys.update",
      api_key_id: apiKeyId,
      description: "Renamed audited project key",
    },
  });
});

it("records Teams admin mutations (create/update/delete, membership, permissions, checkout, item quantity) and skips client self-service", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    },
  });
  await Payments.setup();
  await Project.updateConfig({
    teams: {
      allowClientTeamCreation: true,
    },
    payments: {
      testMode: true,
      items: {
        "team-credits": {
          displayName: "Team Credits",
          customerType: "team",
        },
      },
      products: {
        "team-product": {
          displayName: "Team Product",
          customerType: "team",
          serverOnly: false,
          stackable: true,
          prices: {
            monthly: {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId: memberUserId } = await Auth.Password.signUpWithEmail();
  await Auth.signOut();

  const createTeam = await niceBackendFetch("/api/v1/teams", {
    accessType: "admin",
    method: "POST",
    body: {
      display_name: "Audited Team",
      client_metadata: { plan: "starter" },
      client_read_only_metadata: { seat_limit: 5 },
      server_metadata: { internal_note: "vip" },
    },
  });
  expect(createTeam.status).toBe(201);
  const teamId = createTeam.body.id as string;

  const rename = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      display_name: "Renamed Audited Team",
      client_metadata: { plan: "pro" },
      client_read_only_metadata: { seat_limit: 10 },
      server_metadata: { internal_note: "vip-renewed" },
    },
  });
  expect(rename.status).toBe(200);

  const addMember = await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${memberUserId}`, {
    accessType: "admin",
    method: "POST",
    body: {},
  });
  expect(addMember.status).toBe(201);

  const grantPermission = await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${memberUserId}/$update_team`, {
    accessType: "admin",
    method: "POST",
    body: {},
  });
  expect(grantPermission.status).toBe(201);

  const revokePermission = await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${memberUserId}/$update_team`, {
    accessType: "admin",
    method: "DELETE",
  });
  expect(revokePermission.status).toBe(200);

  const quantityChange = await niceBackendFetch(`/api/v1/payments/items/team/${teamId}/team-credits/update-quantity?allow_negative=false`, {
    accessType: "admin",
    method: "POST",
    body: {
      delta: 7,
      description: "manual team grant",
    },
  });
  expect(quantityChange.status).toBe(200);

  const checkout = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    accessType: "admin",
    method: "POST",
    body: {
      customer_type: "team",
      customer_id: teamId,
      product_id: "team-product",
    },
  });
  expect(checkout.status).toBe(200);
  const checkoutUrl = checkout.body.url as string;
  expect(typeof checkoutUrl).toBe("string");

  const removeMember = await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${memberUserId}`, {
    accessType: "admin",
    method: "DELETE",
  });
  expect(removeMember.status).toBe(200);

  const deleteTeam = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "admin",
    method: "DELETE",
  });
  expect(deleteTeam.status).toBe(200);

  // Client self-service team create must not write admin audit events.
  await bumpEmailAddress();
  await Auth.Password.signUpWithEmail();
  const clientCreate = await niceBackendFetch("/api/v1/teams", {
    accessType: "client",
    method: "POST",
    body: {
      display_name: "Client Self-Service Team",
      creator_user_id: "me",
    },
  });
  expect(clientCreate.status).toBe(201);
  const clientTeamId = clientCreate.body.id as string;

  const createdList = await listAuditLog({ action: "team.created" });
  expect(createdList.status).toBe(200);
  expect(createdList.body.items).toHaveLength(1);
  expect(createdList.body.items[0]).toMatchObject({
    action: "team.created",
    target_user_id: null,
    metadata: {
      source: "teams.create",
      changed_paths: expect.arrayContaining([
        "team_id",
        "display_name",
        "client_metadata.plan",
        "client_read_only_metadata.seat_limit",
        "server_metadata.internal_note",
      ]),
      changes: {
        display_name: { before: null, after: "Audited Team" },
        "client_metadata.plan": { before: null, after: "starter" },
        "client_read_only_metadata.seat_limit": { before: null, after: 5 },
        "server_metadata.internal_note": { before: null, after: "vip" },
      },
    },
  });
  expect(createdList.body.items[0].metadata.changes.team_id.after).toBe(teamId);
  expect(JSON.stringify(createdList.body.items)).not.toContain("Client Self-Service Team");
  expect(JSON.stringify(createdList.body.items)).not.toContain(clientTeamId);

  const updatedList = await listAuditLog({ action: "team.updated" });
  expect(updatedList.status).toBe(200);
  expect(updatedList.body.items).toHaveLength(1);
  expect(updatedList.body.items[0]).toMatchObject({
    action: "team.updated",
    metadata: {
      source: "teams.update",
      team_id: teamId,
      changed_paths: expect.arrayContaining([
        "display_name",
        "client_metadata.plan",
        "client_read_only_metadata.seat_limit",
        "server_metadata.internal_note",
      ]),
      changes: {
        display_name: { before: "Audited Team", after: "Renamed Audited Team" },
        "client_metadata.plan": { before: "starter", after: "pro" },
        "client_read_only_metadata.seat_limit": { before: 5, after: 10 },
        "server_metadata.internal_note": { before: "vip", after: "vip-renewed" },
      },
    },
  });

  const membershipCreated = await listAuditLog({ action: "team_membership.created" });
  expect(membershipCreated.status).toBe(200);
  expect(membershipCreated.body.items).toHaveLength(1);
  expect(membershipCreated.body.items[0]).toMatchObject({
    action: "team_membership.created",
    target_user_id: memberUserId,
    metadata: {
      source: "team_memberships.create",
      changes: {
        team_id: { before: null, after: teamId },
        user_id: { before: null, after: memberUserId },
      },
    },
  });

  const membershipDeleted = await listAuditLog({ action: "team_membership.deleted" });
  expect(membershipDeleted.status).toBe(200);
  expect(membershipDeleted.body.items).toHaveLength(1);
  expect(membershipDeleted.body.items[0]).toMatchObject({
    action: "team_membership.deleted",
    target_user_id: memberUserId,
    metadata: {
      source: "team_memberships.delete",
      team_id: teamId,
      user_id: memberUserId,
    },
  });

  const permissionGranted = await listAuditLog({ action: "team_permission.granted" });
  expect(permissionGranted.status).toBe(200);
  expect(permissionGranted.body.items).toHaveLength(1);
  expect(permissionGranted.body.items[0]).toMatchObject({
    action: "team_permission.granted",
    target_user_id: memberUserId,
    metadata: {
      source: "team_permissions.create",
      changes: {
        team_id: { before: null, after: teamId },
        user_id: { before: null, after: memberUserId },
        permission_id: { before: null, after: "$update_team" },
      },
    },
  });

  const permissionRevoked = await listAuditLog({ action: "team_permission.revoked" });
  expect(permissionRevoked.status).toBe(200);
  expect(permissionRevoked.body.items).toHaveLength(1);
  expect(permissionRevoked.body.items[0]).toMatchObject({
    action: "team_permission.revoked",
    target_user_id: memberUserId,
    metadata: {
      source: "team_permissions.delete",
      team_id: teamId,
      user_id: memberUserId,
      permission_id: "$update_team",
    },
  });

  const itemQuantity = await listAuditLog({ action: "payment.item_quantity.changed" });
  expect(itemQuantity.status).toBe(200);
  expect(itemQuantity.body.items).toHaveLength(1);
  expect(itemQuantity.body.items[0]).toMatchObject({
    action: "payment.item_quantity.changed",
    metadata: {
      source: "payments.items.update_quantity",
      customer_type: "team",
      customer_id: teamId,
      item_id: "team-credits",
      delta: 7,
      allow_negative: false,
      description: "manual team grant",
      changes: {
        delta: { before: null, after: 7 },
      },
    },
  });

  const checkoutList = await listAuditLog({ action: "payment.checkout.created" });
  expect(checkoutList.status).toBe(200);
  expect(checkoutList.body.items).toHaveLength(1);
  expect(checkoutList.body.items[0]).toMatchObject({
    action: "payment.checkout.created",
    metadata: {
      source: "payments.create_purchase_url",
      changes: {
        customer_type: { before: null, after: "team" },
        customer_id: { before: null, after: teamId },
        product_id: { before: null, after: "team-product" },
        has_product_inline: { before: null, after: false },
      },
    },
  });
  expect(JSON.stringify(checkoutList.body.items[0].metadata)).not.toContain(checkoutUrl);
  expect(JSON.stringify(checkoutList.body.items[0].metadata)).not.toContain("/purchase/");

  const deletedList = await listAuditLog({ action: "team.deleted" });
  expect(deletedList.status).toBe(200);
  expect(deletedList.body.items).toHaveLength(1);
  expect(deletedList.body.items[0]).toMatchObject({
    action: "team.deleted",
    metadata: {
      source: "teams.delete",
      team_id: teamId,
      display_name: "Renamed Audited Team",
    },
  });
});

it("records RBAC permission definition and project permission changes only for dashboard admin users", async ({ expect }) => {
  await Project.createAndSwitch({
    config: { magic_link_enabled: true },
  });
  const projectKeys = backendContext.value.projectKeys;
  // vitest expect().not.toBe() does not narrow the ProjectKeys union, so throw to
  // exclude "no-project" before spreading keys or reading adminAccessToken.
  if (projectKeys === "no-project") {
    throw new Error("Expected project keys after Project.createAndSwitch");
  }
  const dashboardAdminAccessToken = projectKeys.adminAccessToken;
  expect(typeof dashboardAdminAccessToken).toBe("string");

  // Bare admin API key (no dashboard admin user) must not write Compliance events.
  backendContext.set({
    projectKeys: {
      ...projectKeys,
      adminAccessToken: undefined,
    },
  });
  const programmaticCreate = await niceBackendFetch("/api/v1/project-permission-definitions", {
    accessType: "admin",
    method: "POST",
    body: {
      id: "programmatic_perm",
      description: "Should not be audited",
    },
  });
  expect(programmaticCreate.status).toBe(201);

  const programmaticList = await listAuditLog({ action: "permission_definition.created" });
  expect(programmaticList.status).toBe(200);
  expect(programmaticList.body.items).toEqual([]);

  backendContext.set({
    projectKeys: {
      ...projectKeys,
      adminAccessToken: dashboardAdminAccessToken,
    },
  });

  const createDef = await niceBackendFetch("/api/v1/project-permission-definitions", {
    accessType: "admin",
    method: "POST",
    body: {
      id: "audited_perm",
      description: "Audited project permission",
      contained_permission_ids: [],
    },
  });
  expect(createDef.status).toBe(201);

  const createTeamDef = await niceBackendFetch("/api/v1/team-permission-definitions", {
    accessType: "admin",
    method: "POST",
    body: {
      id: "audited_team_perm",
      description: "Audited team permission",
    },
  });
  expect(createTeamDef.status).toBe(201);

  const updateDef = await niceBackendFetch("/api/v1/project-permission-definitions/audited_perm", {
    accessType: "admin",
    method: "PATCH",
    body: {
      description: "Renamed audited project permission",
      contained_permission_ids: [],
    },
  });
  expect(updateDef.status).toBe(200);

  const { userId } = await Auth.Password.signUpWithEmail();
  await Auth.signOut();

  const grant = await niceBackendFetch(`/api/v1/project-permissions/${userId}/audited_perm`, {
    accessType: "admin",
    method: "POST",
    body: {},
  });
  expect(grant.status).toBe(201);

  // Programmatic grant with admin key alone must not audit.
  backendContext.set({
    projectKeys: {
      ...projectKeys,
      adminAccessToken: undefined,
    },
  });
  const programmaticGrant = await niceBackendFetch(`/api/v1/project-permissions/${userId}/programmatic_perm`, {
    accessType: "admin",
    method: "POST",
    body: {},
  });
  expect(programmaticGrant.status).toBe(201);
  backendContext.set({
    projectKeys: {
      ...projectKeys,
      adminAccessToken: dashboardAdminAccessToken,
    },
  });

  const revoke = await niceBackendFetch(`/api/v1/project-permissions/${userId}/audited_perm`, {
    accessType: "admin",
    method: "DELETE",
  });
  expect(revoke.status).toBe(200);

  const deleteDef = await niceBackendFetch("/api/v1/project-permission-definitions/audited_perm", {
    accessType: "admin",
    method: "DELETE",
  });
  expect(deleteDef.status).toBe(200);

  const createdDefs = await listAuditLog({ action: "permission_definition.created" });
  expect(createdDefs.status).toBe(200);
  expect(createdDefs.body.items).toHaveLength(2);
  expect(createdDefs.body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      action: "permission_definition.created",
      actor_type: "admin_user",
      metadata: expect.objectContaining({
        source: "project_permission_definitions.create",
        changes: expect.objectContaining({
          scope: { before: null, after: "project" },
          permission_id: { before: null, after: "audited_perm" },
          description: { before: null, after: "Audited project permission" },
        }),
      }),
    }),
    expect.objectContaining({
      action: "permission_definition.created",
      actor_type: "admin_user",
      metadata: expect.objectContaining({
        source: "team_permission_definitions.create",
        changes: expect.objectContaining({
          scope: { before: null, after: "team" },
          permission_id: { before: null, after: "audited_team_perm" },
        }),
      }),
    }),
  ]));
  expect(JSON.stringify(createdDefs.body.items)).not.toContain("programmatic_perm");
  expect(JSON.stringify(createdDefs.body.items)).not.toContain("Should not be audited");

  const updatedDefs = await listAuditLog({ action: "permission_definition.updated" });
  expect(updatedDefs.status).toBe(200);
  expect(updatedDefs.body.items).toHaveLength(1);
  expect(updatedDefs.body.items[0]).toMatchObject({
    action: "permission_definition.updated",
    actor_type: "admin_user",
    metadata: {
      source: "project_permission_definitions.update",
      scope: "project",
      permission_id: "audited_perm",
      changes: {
        description: {
          before: "Audited project permission",
          after: "Renamed audited project permission",
        },
      },
    },
  });

  const granted = await listAuditLog({ action: "project_permission.granted" });
  expect(granted.status).toBe(200);
  expect(granted.body.items).toHaveLength(1);
  expect(granted.body.items[0]).toMatchObject({
    action: "project_permission.granted",
    actor_type: "admin_user",
    target_user_id: userId,
    metadata: {
      source: "project_permissions.create",
      changes: {
        user_id: { before: null, after: userId },
        permission_id: { before: null, after: "audited_perm" },
      },
    },
  });

  const revoked = await listAuditLog({ action: "project_permission.revoked" });
  expect(revoked.status).toBe(200);
  expect(revoked.body.items).toHaveLength(1);
  expect(revoked.body.items[0]).toMatchObject({
    action: "project_permission.revoked",
    actor_type: "admin_user",
    target_user_id: userId,
    metadata: {
      source: "project_permissions.delete",
      user_id: userId,
      permission_id: "audited_perm",
    },
  });

  const deletedDefs = await listAuditLog({ action: "permission_definition.deleted" });
  expect(deletedDefs.status).toBe(200);
  expect(deletedDefs.body.items).toHaveLength(1);
  expect(deletedDefs.body.items[0]).toMatchObject({
    action: "permission_definition.deleted",
    actor_type: "admin_user",
    metadata: {
      source: "project_permission_definitions.delete",
      scope: "project",
      permission_id: "audited_perm",
      description: "Renamed audited project permission",
    },
  });
});

it("records Payments dashboard mutations (checkout, item quantity, stripe setup, method config, refund) and skips client checkout", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      items: {
        "user-credits": {
          displayName: "User Credits",
          customerType: "user",
        },
      },
      products: {
        "user-product": {
          displayName: "User Product",
          customerType: "user",
          serverOnly: false,
          stackable: true,
          prices: {
            monthly: {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const setupList = await listAuditLog({ action: "payment.stripe.setup_started" });
  expect(setupList.status).toBe(200);
  expect(setupList.body.items.length).toBeGreaterThanOrEqual(1);
  expect(setupList.body.items[0]).toMatchObject({
    action: "payment.stripe.setup_started",
    actor_type: "admin_user",
    metadata: {
      source: "payments.setup",
      changes: {
        stripe_account_created: { before: null, after: expect.any(Boolean) },
      },
    },
  });
  expect(JSON.stringify(setupList.body.items[0].metadata)).not.toContain("account_links");
  expect(JSON.stringify(setupList.body.items[0].metadata)).not.toContain("stripe.com");

  const methodConfigs = await niceBackendFetch("/api/v1/internal/payments/method-configs", {
    accessType: "admin",
  });
  expect(methodConfigs.status).toBe(200);
  const configId = methodConfigs.body.config_id as string;
  const methodPatch = await niceBackendFetch("/api/v1/internal/payments/method-configs", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config_id: configId,
      updates: {
        card: "on",
      },
    },
  });
  expect(methodPatch.status).toBe(200);

  const { userId } = await Auth.Password.signUpWithEmail();

  const adminCheckout = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    accessType: "admin",
    method: "POST",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "user-product",
    },
  });
  expect(adminCheckout.status).toBe(200);
  const checkoutUrl = adminCheckout.body.url as string;

  const quantityChange = await niceBackendFetch(`/api/v1/payments/items/user/${userId}/user-credits/update-quantity?allow_negative=false`, {
    accessType: "admin",
    method: "POST",
    body: {
      delta: 3,
      description: "manual user grant",
    },
  });
  expect(quantityChange.status).toBe(200);

  // Server-granted product (no Stripe money) — used so refund is dashboard-auditable without a live charge.
  const grantRes = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "server",
    method: "POST",
    body: { product_id: "user-product" },
  });
  expect(grantRes.status).toBe(200);
  const txnsRes = await niceBackendFetch("/api/v1/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(txnsRes.status).toBe(200);
  const purchaseTxn = txnsRes.body.transactions.find((tx: { type: string }) => tx.type === "purchase");
  expect(purchaseTxn).toBeDefined();

  const refundRes = await niceBackendFetch("/api/v1/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: purchaseTxn.id,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
  const refundTransactionId = refundRes.body.refund_transaction_id as string;

  // Client self-service checkout must not write Compliance events.
  // Prefer backendContext userAuth (auto-refresh) over a captured access token —
  // long admin steps above can outlive a short-lived JWT.
  const clientCheckout = await niceBackendFetch("/api/v1/payments/purchases/create-purchase-url", {
    accessType: "client",
    method: "POST",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "user-product",
    },
  });
  expect(clientCheckout.status).toBe(200);

  const checkoutList = await listAuditLog({ action: "payment.checkout.created" });
  expect(checkoutList.status).toBe(200);
  expect(checkoutList.body.items).toHaveLength(1);
  expect(checkoutList.body.items[0]).toMatchObject({
    action: "payment.checkout.created",
    actor_type: "admin_user",
    target_user_id: userId,
    metadata: {
      source: "payments.create_purchase_url",
      changes: {
        customer_type: { before: null, after: "user" },
        customer_id: { before: null, after: userId },
        product_id: { before: null, after: "user-product" },
      },
    },
  });
  expect(JSON.stringify(checkoutList.body.items[0].metadata)).not.toContain(checkoutUrl);
  expect(JSON.stringify(checkoutList.body.items[0].metadata)).not.toContain("/purchase/");

  const itemQuantity = await listAuditLog({ action: "payment.item_quantity.changed" });
  expect(itemQuantity.status).toBe(200);
  expect(itemQuantity.body.items).toHaveLength(1);
  expect(itemQuantity.body.items[0]).toMatchObject({
    action: "payment.item_quantity.changed",
    actor_type: "admin_user",
    target_user_id: userId,
    metadata: {
      source: "payments.items.update_quantity",
      customer_type: "user",
      customer_id: userId,
      item_id: "user-credits",
      delta: 3,
      description: "manual user grant",
      changes: {
        delta: { before: null, after: 3 },
      },
    },
  });

  const methodConfigList = await listAuditLog({ action: "payment.method_config.updated" });
  expect(methodConfigList.status).toBe(200);
  expect(methodConfigList.body.items).toHaveLength(1);
  expect(methodConfigList.body.items[0]).toMatchObject({
    action: "payment.method_config.updated",
    actor_type: "admin_user",
    metadata: {
      source: "payments.method_configs.update",
      config_id: configId,
      changes: expect.objectContaining({
        "methods.card.preference": expect.objectContaining({ after: "on" }),
      }),
    },
  });

  const refundList = await listAuditLog({ action: "payment.refund.created" });
  expect(refundList.status).toBe(200);
  expect(refundList.body.items).toHaveLength(1);
  expect(refundList.body.items[0]).toMatchObject({
    action: "payment.refund.created",
    actor_type: "admin_user",
    target_user_id: userId,
    metadata: {
      source: "payments.transactions.refund",
      changes: {
        purchase_type: { before: null, after: "subscription" },
        purchase_id: { before: null, after: purchaseTxn.id },
        amount_usd: { before: null, after: "0" },
        refund_transaction_id: { before: null, after: refundTransactionId },
        end_action: { before: null, after: "now" },
        customer_type: { before: null, after: "user" },
        customer_id: { before: null, after: userId },
      },
    },
  });
  expect(JSON.stringify(refundList.body.items[0].metadata)).not.toContain("pi_");
  expect(JSON.stringify(refundList.body.items[0].metadata)).not.toContain("payment_intent");
});

const AUDITED_TEMPLATE_SOURCE = `
  import { Subject, NotificationCategory } from '@stackframe/emails';
  export const variablesSchema = (v) => v;
  export function EmailTemplate() {
    return <>
      <Subject value="Audited Template Subject" />
      <NotificationCategory value="Transactional" />
      <div>Audited template</div>
    </>;
  }
`;

const AUDITED_THEME_SOURCE = `import { Html, Tailwind, Body } from '@react-email/components';
export function EmailTheme({ children }: { children: React.ReactNode }) {
  return (
    <Html>
      <Tailwind>
        <Body>
          <div className="bg-white text-slate-800 p-4 rounded-lg max-w-[600px] mx-auto leading-relaxed">
            {children}
          </div>
        </Body>
      </Tailwind>
    </Html>
  );
}`;

async function waitForManagedDomainStatus(options: {
  domainId: string,
  subdomain: string,
  senderLocalPart: string,
  status: string,
}) {
  const deadline = performance.now() + 10_000;
  let lastBody: unknown = undefined;
  while (performance.now() < deadline) {
    const response = await niceBackendFetch("/api/v1/internal/emails/managed-onboarding/check", {
      method: "POST",
      accessType: "admin",
      body: {
        domain_id: options.domainId,
        subdomain: options.subdomain,
        sender_local_part: options.senderLocalPart,
      },
    });
    lastBody = response.body;
    if (response.status === 200 && response.body.status === options.status) {
      return;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for managed email domain ${options.domainId} to become ${options.status}; last response body: ${JSON.stringify(lastBody)}`);
}

it("records Emails dashboard mutations (templates, themes, drafts, managed domain) and skips admin-key-only template create", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
      email_config: {
        type: "standard",
        host: "smtp.example.com",
        port: 587,
        username: "test@example.com",
        password: "password123",
        sender_name: "Test App",
        sender_email: "noreply@example.com",
      },
    },
  });
  const projectKeys = backendContext.value.projectKeys;
  if (projectKeys === "no-project") {
    throw new Error("Expected project keys after Project.createAndSwitch");
  }
  const dashboardAdminAccessToken = projectKeys.adminAccessToken;
  expect(typeof dashboardAdminAccessToken).toBe("string");

  backendContext.set({
    projectKeys: {
      ...projectKeys,
      adminAccessToken: undefined,
    },
  });
  const programmaticCreate = await niceBackendFetch("/api/v1/internal/email-templates", {
    method: "POST",
    accessType: "admin",
    body: { display_name: "Programmatic Template" },
  });
  expect(programmaticCreate.status).toBe(200);
  const programmaticList = await listAuditLog({ action: "email.template.created" });
  expect(programmaticList.status).toBe(200);
  expect(programmaticList.body.items).toEqual([]);

  backendContext.set({
    projectKeys: {
      ...projectKeys,
      adminAccessToken: dashboardAdminAccessToken,
    },
  });

  const createTemplate = await niceBackendFetch("/api/v1/internal/email-templates", {
    method: "POST",
    accessType: "admin",
    body: { display_name: "Audited Template" },
  });
  expect(createTemplate.status).toBe(200);
  const templateId = createTemplate.body.id as string;

  const updateTemplate = await niceBackendFetch(`/api/v1/internal/email-templates/${templateId}`, {
    method: "PATCH",
    accessType: "admin",
    body: { tsx_source: AUDITED_TEMPLATE_SOURCE },
  });
  expect(updateTemplate.status).toBe(200);

  const deleteTemplate = await niceBackendFetch(`/api/v1/internal/email-templates/${templateId}`, {
    method: "DELETE",
    accessType: "admin",
  });
  expect(deleteTemplate.status).toBe(200);

  const createTheme = await niceBackendFetch("/api/v1/internal/email-themes", {
    method: "POST",
    accessType: "admin",
    body: { display_name: "Audited Theme" },
  });
  expect(createTheme.status).toBe(200);
  const themeId = createTheme.body.id as string;

  const updateTheme = await niceBackendFetch(`/api/v1/internal/email-themes/${themeId}`, {
    method: "PATCH",
    accessType: "admin",
    body: { tsx_source: AUDITED_THEME_SOURCE },
  });
  expect(updateTheme.status).toBe(200);

  const deleteTheme = await niceBackendFetch(`/api/v1/internal/email-themes/${themeId}`, {
    method: "DELETE",
    accessType: "admin",
  });
  expect(deleteTheme.status).toBe(200);

  const createDraft = await niceBackendFetch("/api/v1/internal/email-drafts", {
    method: "POST",
    accessType: "admin",
    body: {
      display_name: "Audited Draft",
      theme_id: false,
    },
  });
  expect(createDraft.status).toBe(200);
  const draftId = createDraft.body.id as string;

  const updateDraft = await niceBackendFetch(`/api/v1/internal/email-drafts/${draftId}`, {
    method: "PATCH",
    accessType: "admin",
    body: {
      display_name: "Renamed Audited Draft",
      tsx_source: AUDITED_TEMPLATE_SOURCE,
    },
  });
  expect(updateDraft.status).toBe(200);

  const deleteDraft = await niceBackendFetch(`/api/v1/internal/email-drafts/${draftId}`, {
    method: "DELETE",
    accessType: "admin",
  });
  expect(deleteDraft.status).toBe(200);

  const setupToDelete = await niceBackendFetch("/api/v1/internal/emails/managed-onboarding/setup", {
    method: "POST",
    accessType: "admin",
    body: {
      subdomain: "audit-delete.example.com",
      sender_local_part: "noreply",
    },
  });
  expect(setupToDelete.status).toBe(200);
  const deletedDomainId = setupToDelete.body.domain_id as string;
  const deleteDomain = await niceBackendFetch("/api/v1/internal/emails/managed-onboarding/delete", {
    method: "POST",
    accessType: "admin",
    body: { resend_domain_id: deletedDomainId },
  });
  expect(deleteDomain.status).toBe(200);

  const setupToApply = await niceBackendFetch("/api/v1/internal/emails/managed-onboarding/setup", {
    method: "POST",
    accessType: "admin",
    body: {
      subdomain: "audit-apply.example.com",
      sender_local_part: "hello",
    },
  });
  expect(setupToApply.status).toBe(200);
  const appliedDomainId = setupToApply.body.domain_id as string;
  await waitForManagedDomainStatus({
    domainId: appliedDomainId,
    subdomain: "audit-apply.example.com",
    senderLocalPart: "hello",
    status: "verified",
  });
  const applyDomain = await niceBackendFetch("/api/v1/internal/emails/managed-onboarding/apply", {
    method: "POST",
    accessType: "admin",
    body: { domain_id: appliedDomainId },
  });
  expect(applyDomain.status).toBe(200);

  const createdTemplates = await listAuditLog({ action: "email.template.created" });
  expect(createdTemplates.status).toBe(200);
  expect(createdTemplates.body.items).toHaveLength(1);
  expect(createdTemplates.body.items[0]).toMatchObject({
    action: "email.template.created",
    actor_type: "admin_user",
    metadata: {
      source: "email_templates.create",
      changes: {
        template_id: { before: null, after: templateId },
        display_name: { before: null, after: "Audited Template" },
      },
    },
  });
  expect(JSON.stringify(createdTemplates.body.items[0].metadata)).not.toContain("Programmatic Template");
  expect(JSON.stringify(createdTemplates.body.items[0].metadata)).not.toContain("export function EmailTemplate");

  const updatedTemplates = await listAuditLog({ action: "email.template.updated" });
  expect(updatedTemplates.status).toBe(200);
  expect(updatedTemplates.body.items).toHaveLength(1);
  expect(updatedTemplates.body.items[0]).toMatchObject({
    action: "email.template.updated",
    actor_type: "admin_user",
    metadata: {
      source: "email_templates.update",
      template_id: templateId,
      display_name: "Audited Template",
      changes: {
        tsx_source_updated: { before: false, after: true },
      },
    },
  });
  expect(JSON.stringify(updatedTemplates.body.items[0].metadata)).not.toContain("Audited Template Subject");
  expect(JSON.stringify(updatedTemplates.body.items[0].metadata)).not.toContain("export function EmailTemplate");

  const deletedTemplates = await listAuditLog({ action: "email.template.deleted" });
  expect(deletedTemplates.status).toBe(200);
  expect(deletedTemplates.body.items).toHaveLength(1);
  expect(deletedTemplates.body.items[0]).toMatchObject({
    action: "email.template.deleted",
    actor_type: "admin_user",
    metadata: {
      source: "email_templates.delete",
      changes: {
        template_id: { before: null, after: templateId },
        display_name: { before: null, after: "Audited Template" },
      },
    },
  });

  const createdThemes = await listAuditLog({ action: "email.theme.created" });
  expect(createdThemes.status).toBe(200);
  expect(createdThemes.body.items).toHaveLength(1);
  expect(createdThemes.body.items[0]).toMatchObject({
    action: "email.theme.created",
    actor_type: "admin_user",
    metadata: {
      source: "email_themes.create",
      changes: {
        theme_id: { before: null, after: themeId },
        display_name: { before: null, after: "Audited Theme" },
      },
    },
  });

  const updatedThemes = await listAuditLog({ action: "email.theme.updated" });
  expect(updatedThemes.status).toBe(200);
  expect(updatedThemes.body.items).toHaveLength(1);
  expect(updatedThemes.body.items[0]).toMatchObject({
    action: "email.theme.updated",
    actor_type: "admin_user",
    metadata: {
      source: "email_themes.update",
      theme_id: themeId,
      display_name: "Audited Theme",
      changes: {
        tsx_source_updated: { before: false, after: true },
      },
    },
  });
  expect(JSON.stringify(updatedThemes.body.items[0].metadata)).not.toContain("export function EmailTheme");

  const deletedThemes = await listAuditLog({ action: "email.theme.deleted" });
  expect(deletedThemes.status).toBe(200);
  expect(deletedThemes.body.items).toHaveLength(1);
  expect(deletedThemes.body.items[0]).toMatchObject({
    action: "email.theme.deleted",
    actor_type: "admin_user",
    metadata: {
      source: "email_themes.delete",
      changes: {
        theme_id: { before: null, after: themeId },
        display_name: { before: null, after: "Audited Theme" },
      },
    },
  });

  const createdDrafts = await listAuditLog({ action: "email.draft.created" });
  expect(createdDrafts.status).toBe(200);
  expect(createdDrafts.body.items).toHaveLength(1);
  expect(createdDrafts.body.items[0]).toMatchObject({
    action: "email.draft.created",
    actor_type: "admin_user",
    metadata: {
      source: "email_drafts.create",
      changes: {
        draft_id: { before: null, after: draftId },
        display_name: { before: null, after: "Audited Draft" },
        theme_id: { before: null, after: false },
      },
    },
  });

  const updatedDrafts = await listAuditLog({ action: "email.draft.updated" });
  expect(updatedDrafts.status).toBe(200);
  expect(updatedDrafts.body.items).toHaveLength(1);
  expect(updatedDrafts.body.items[0]).toMatchObject({
    action: "email.draft.updated",
    actor_type: "admin_user",
    metadata: {
      source: "email_drafts.update",
      draft_id: draftId,
      changes: {
        display_name: { before: "Audited Draft", after: "Renamed Audited Draft" },
        tsx_source_updated: { before: false, after: true },
      },
    },
  });
  expect(JSON.stringify(updatedDrafts.body.items[0].metadata)).not.toContain("export function EmailTemplate");

  const deletedDrafts = await listAuditLog({ action: "email.draft.deleted" });
  expect(deletedDrafts.status).toBe(200);
  expect(deletedDrafts.body.items).toHaveLength(1);
  expect(deletedDrafts.body.items[0]).toMatchObject({
    action: "email.draft.deleted",
    actor_type: "admin_user",
    metadata: {
      source: "email_drafts.delete",
      changes: {
        draft_id: { before: null, after: draftId },
        display_name: { before: null, after: "Renamed Audited Draft" },
      },
    },
  });

  const setupList = await listAuditLog({ action: "email.managed_domain.setup_started" });
  expect(setupList.status).toBe(200);
  expect(setupList.body.items).toHaveLength(2);
  expect(setupList.body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      action: "email.managed_domain.setup_started",
      actor_type: "admin_user",
      metadata: expect.objectContaining({
        source: "emails.managed_onboarding.setup",
        changes: expect.objectContaining({
          domain_id: { before: null, after: deletedDomainId },
          subdomain: { before: null, after: "audit-delete.example.com" },
          sender_local_part: { before: null, after: "noreply" },
          status: { before: null, after: "pending_verification" },
        }),
      }),
    }),
    expect.objectContaining({
      action: "email.managed_domain.setup_started",
      actor_type: "admin_user",
      metadata: expect.objectContaining({
        source: "emails.managed_onboarding.setup",
        changes: expect.objectContaining({
          domain_id: { before: null, after: appliedDomainId },
          subdomain: { before: null, after: "audit-apply.example.com" },
          sender_local_part: { before: null, after: "hello" },
          status: { before: null, after: "pending_verification" },
        }),
      }),
    }),
  ]));

  const appliedList = await listAuditLog({ action: "email.managed_domain.applied" });
  expect(appliedList.status).toBe(200);
  expect(appliedList.body.items).toHaveLength(1);
  expect(appliedList.body.items[0]).toMatchObject({
    action: "email.managed_domain.applied",
    actor_type: "admin_user",
    metadata: {
      source: "emails.managed_onboarding.apply",
      changes: {
        domain_id: { before: null, after: appliedDomainId },
        provider: { before: null, after: "managed" },
      },
    },
  });
  expect(JSON.stringify(appliedList.body.items[0].metadata)).not.toContain("managed_mock_key_");
  expect(JSON.stringify(appliedList.body.items[0].metadata)).not.toContain("password");

  const deletedDomains = await listAuditLog({ action: "email.managed_domain.deleted" });
  expect(deletedDomains.status).toBe(200);
  expect(deletedDomains.body.items).toHaveLength(1);
  expect(deletedDomains.body.items[0]).toMatchObject({
    action: "email.managed_domain.deleted",
    actor_type: "admin_user",
    metadata: {
      source: "emails.managed_onboarding.delete",
      changes: {
        domain_id: { before: null, after: deletedDomainId },
      },
    },
  });
});
