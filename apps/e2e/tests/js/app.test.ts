import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { KnownErrors } from "@hexclave/shared";
import { StackServerApp } from "@hexclave/js";
import { SDK_BASE_URL, it } from "../helpers";
import { createApp, scaffoldProject } from "./js-helpers";


it("should scaffold the project", async ({ expect }) => {
  const { project } = await scaffoldProject();
  expect(project.displayName).toBe("New Project");
});

it("should sign up with credential", async ({ expect }) => {
  const { clientApp } = await createApp();
  const result1 = await clientApp.signUpWithCredential({
    email: "test@test.com",
    password: "password",
    noVerificationCallback: true,
  });

  expect(result1).toMatchInlineSnapshot(`
    {
      "data": undefined,
      "status": "ok",
    }
  `);

  const result2 = await clientApp.signInWithCredential({
    email: "test@test.com",
    password: "password",
  });

  expect(result2).toMatchInlineSnapshot(`
    {
      "data": undefined,
      "status": "ok",
    }
  `);
});

it("should sign up without a verification callback when disabled", async ({ expect }) => {
  const { clientApp } = await createApp();
  const signUpResult = await clientApp.signUpWithCredential({
    email: "no-verification@test.com",
    password: "password",
    noVerificationCallback: true,
  });

  expect(signUpResult).toMatchInlineSnapshot(`
    {
      "data": undefined,
      "status": "ok",
    }
  `);

  const signInResult = await clientApp.signInWithCredential({
    email: "no-verification@test.com",
    password: "password",
  });

  expect(signInResult).toMatchInlineSnapshot(`
    {
      "data": undefined,
      "status": "ok",
    }
  `);
});

it("should return a known error when signing up with an email used by another account", async ({ expect }) => {
  const { clientApp } = await createApp();
  const email = "already-used@test.com";

  expect(await clientApp.signUpWithCredential({
    email,
    password: "password",
    noVerificationCallback: true,
  })).toMatchInlineSnapshot(`
    {
      "data": undefined,
      "status": "ok",
    }
  `);

  await clientApp.signOut();

  const result = await clientApp.signUpWithCredential({
    email,
    password: "password",
    noVerificationCallback: true,
  });

  expect(result.status).toBe("error");
  if (result.status !== "error") {
    throw new Error("Expected credential signup to return a known error");
  }
  expect(KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse.isInstance(result.error)).toBe(true);
  expect({
    status: result.status,
    errorCode: result.error.errorCode,
  }).toMatchInlineSnapshot(`
    {
      "errorCode": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
      "status": "error",
    }
  `);
});

it("should throw when disabling verification with a callback url provided", async ({ expect }) => {
  const { clientApp } = await createApp();

  await expect(clientApp.signUpWithCredential({
    email: "no-verification-conflict@test.com",
    password: "password",
    noVerificationCallback: true,
    // @ts-expect-error - testing the error case
    verificationCallbackUrl: "http://localhost:3000",
  })).rejects.toMatchObject({
    message: expect.stringContaining("verificationCallbackUrl is not allowed when noVerificationCallback is true"),
    name: "HexclaveAssertionError",
  });
});

it("should create user on the server", async ({ expect }) => {
  const { serverApp } = await createApp();
  const user = await serverApp.createUser({
    primaryEmail: "test@test.com",
    password: "password",
    primaryEmailAuthEnabled: true,
  });

  expect(isUuid(user.id)).toBe(true);

  const user2 = await serverApp.getUser(user.id);
  expect(user2?.id).toBe(user.id);

  const result = await serverApp.signInWithCredential({
    email: "test@test.com",
    password: "password",
  });

  expect(result).toMatchInlineSnapshot(`
    {
      "data": undefined,
      "status": "ok",
    }
  `);
});

it("should create user on the server with country code and risk scores", async ({ expect }) => {
  const { serverApp } = await createApp();
  const user = await serverApp.createUser({
    primaryEmail: "imported-risk@test.com",
    primaryEmailAuthEnabled: true,
    countryCode: "US",
    riskScores: {
      signUp: {
        bot: 61,
        freeTrialAbuse: 27,
      },
    },
  });

  expect(user.countryCode).toBe("US");
  expect(user.riskScores).toEqual({
    signUp: {
      bot: 61,
      freeTrialAbuse: 27,
    },
  });
});

it("should throw a helpful error when destructuring user", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp();

  const email = "user-destructure@test.com";
  const password = "password";

  const signUpResult = await clientApp.signUpWithCredential({
    email,
    password,
    noVerificationCallback: true,
  });
  expect(signUpResult.status).toBe("ok");

  const signInResult = await clientApp.signInWithCredential({
    email,
    password,
  });
  expect(signInResult.status).toBe("ok");

  const currentUser = await clientApp.getUser({ or: "throw" });
  const accessClientUser = () => (currentUser as any).user;
  expect(accessClientUser).toThrowError("Hexclave: useUser() already returns the user object. Use `const user = useUser()` (or `const user = await app.getUser()`) instead of destructuring it like `const { user } = ...`.");

  const serverUser = await serverApp.getUser(currentUser.id);
  if (!serverUser) {
    throw new Error("Expected server user to exist for destructure guard test");
  }
  const accessServerUser = () => (serverUser as any).user;
  expect(accessServerUser).toThrowError("Hexclave: useUser() already returns the user object. Use `const user = useUser()` (or `const user = await app.getUser()`) instead of destructuring it like `const { user } = ...`.");
});

it("should not throw from initAnalytics outside the browser when analytics are configured", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp();
  expect(clientApp.initAnalytics()).toBeUndefined();
  expect(serverApp.initAnalytics()).toBeUndefined();
  // Calling it repeatedly (eg. once per page module) must stay harmless.
  expect(clientApp.initAnalytics()).toBeUndefined();
});

it("should throw from initAnalytics when analytics are disabled with the analytics option", async ({ expect }) => {
  const { clientApp } = await createApp(undefined, { client: { analytics: { enabled: false } } });
  expect(() => clientApp.initAnalytics()).toThrowErrorMatchingInlineSnapshot(`[Error: initAnalytics() was called, but this Hexclave app will not record analytics because the \`analytics.enabled\` constructor option is set to false. Remove the initAnalytics() call if this is intentional.]`);
});

it("should throw from initAnalytics when automatic side effects are disabled", async ({ expect }) => {
  const { clientApp } = await createApp(undefined, { client: { automaticSideEffects: false } });
  expect(() => clientApp.initAnalytics()).toThrowErrorMatchingInlineSnapshot(`[Error: initAnalytics() was called, but this Hexclave app will not record analytics because the \`automaticSideEffects\` constructor option is set to false, which also disables analytics. Remove the initAnalytics() call if this is intentional.]`);
});

it("should throw from initAnalytics when the app has no persistent token store", async ({ expect }) => {
  const { project, secretServerKey } = await createApp();
  const serverApp = new StackServerApp({
    baseUrl: SDK_BASE_URL,
    projectId: project.id,
    secretServerKey,
    tokenStore: null,
    redirectMethod: "none",
  });
  expect(() => serverApp.initAnalytics()).toThrowErrorMatchingInlineSnapshot(`[Error: initAnalytics() was called, but this Hexclave app will not record analytics because the \`tokenStore\` constructor option is null; analytics require a persistent token store such as "cookie" (or "nextjs-cookie" in Next.js). Remove the initAnalytics() call if this is intentional.]`);
});
