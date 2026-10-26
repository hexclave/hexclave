import { it } from "../../../../helpers";
import { Auth, backendContext, niceBackendFetch, Project } from "../../../backend-helpers";
import { localhostUrl } from "../../../../helpers/ports";
import { runInNewContext } from "node:vm";

const origin = localhostUrl("01");

async function createAction(body: Record<string, unknown>) {
  return await niceBackendFetch("/api/v1/browser-actions", {
    method: "POST",
    accessType: "server",
    body: {
      type: "clickmap-overlay",
      origin,
      ...body,
    },
  });
}

async function consumeAction(actionId: string, requestOrigin: string | null = origin) {
  return await niceBackendFetch("/api/v1/browser-actions/consume", {
    method: "POST",
    accessType: "client",
    headers: {
      origin: requestOrigin ?? undefined,
    },
    body: {
      action_id: actionId,
    },
  });
}

it("creates and consumes a clickmap browser action once", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();

  const created = await createAction({});
  expect(created.status).toMatchInlineSnapshot(`200`);
  expect(created.body.expires_at_millis).toEqual(expect.any(Number));
  expect(created.body.url).toContain("hexclave_action_id=");

  const consumed = await consumeAction(created.body.id);
  expect(consumed.status).toMatchInlineSnapshot(`200`);
  expect(consumed.body.javascript).toContain("sessionStorage.setItem");
  expect(consumed.body.javascript).toContain("hexclave:clickmap-token-updated");

  const consumedAgain = await consumeAction(created.body.id);
  expect(consumedAgain.status).toMatchInlineSnapshot(`409`);
});

it("creates and consumes an impersonation browser action without returning the refresh token", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();

  const created = await createAction({
    type: "impersonation",
    user_id: userId,
  });
  expect(created.status).toMatchInlineSnapshot(`200`);
  expect(created.body).not.toHaveProperty("refresh_token");

  const consumed = await consumeAction(created.body.id);
  expect(consumed.status).toMatchInlineSnapshot(`200`);
  expect(consumed.body.javascript).toContain("hexclave-refresh-");
  expect(consumed.body.javascript).toContain("window.location.reload");

  const cookies = new Map<string, string>();
  let reloaded = false;
  runInNewContext(consumed.body.javascript, {
    document: {
      set cookie(value: string) {
        const pair = value.split(";")[0];
        const separator = pair.indexOf("=");
        cookies.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1)));
      },
    },
    location: { protocol: "http:" },
    window: { location: { reload: () => { reloaded = true; } } },
  });
  expect(reloaded).toMatchInlineSnapshot(`true`);
  const refreshCookie = [...cookies.entries()].find(([name]) => name.startsWith("stack-refresh-") && !name.endsWith("--default"));
  if (refreshCookie == null) {
    throw new Error("Impersonation must install a refresh token cookie");
  }
  const refreshed = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
    method: "POST",
    accessType: "client",
    userAuth: { refreshToken: refreshCookie[1] },
  });
  expect(refreshed.status).toMatchInlineSnapshot(`200`);
  const impersonatedUser = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    userAuth: { accessToken: refreshed.body.access_token },
  });
  expect(impersonatedUser.status).toMatchInlineSnapshot(`200`);
  expect(impersonatedUser.body.id).toBe(userId);
});

it("rejects missing and mismatched origins", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();

  const created = await createAction({});
  expect(created.status).toMatchInlineSnapshot(`200`);

  const missingOrigin = await consumeAction(created.body.id, null);
  expect(missingOrigin.status).toMatchInlineSnapshot(`403`);

  const mismatchedOrigin = await consumeAction(created.body.id, "http://localhost:8199");
  expect(mismatchedOrigin.status).toMatchInlineSnapshot(`403`);
});

it("rejects untrusted origins and excessive TTLs", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();

  const untrusted = await createAction({
    origin: "https://untrusted.example.com",
  });
  expect(untrusted.status).toMatchInlineSnapshot(`403`);

  const tooLong = await createAction({
    expires_in_millis: 10 * 60 * 1000 + 1,
  });
  expect(tooLong.status).toMatchInlineSnapshot(`400`);

  const sessionTooLong = await createAction({
    type: "impersonation",
    user_id: userId,
    session_expires_in_millis: 1000 * 60 * 60 * 24 * 367 + 1,
  });
  expect(sessionTooLong.status).toMatchInlineSnapshot(`400`);
});

it("rejects expired actions", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();

  const created = await createAction({ expires_in_millis: 1 });
  expect(created.status).toMatchInlineSnapshot(`200`);
  await new Promise(resolve => setTimeout(resolve, 10));

  const consumed = await consumeAction(created.body.id);
  expect(consumed.status).toMatchInlineSnapshot(`403`);
});

it("binds actions to their creating project", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();
  const created = await createAction({});
  expect(created.status).toMatchInlineSnapshot(`200`);

  await Project.createAndSwitch();
  await Auth.fastSignUp();
  const consumed = await consumeAction(created.body.id);
  expect(consumed.status).toMatchInlineSnapshot(`403`);
});

it("rejects client-access action creation", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();
  backendContext.set({ userAuth: null });

  const response = await niceBackendFetch("/api/v1/browser-actions", {
    method: "POST",
    accessType: "client",
    body: {
      type: "clickmap-overlay",
      origin,
    },
  });
  expect(response.status).toMatchInlineSnapshot(`401`);
});
