import { it } from "../../../../../../helpers";
import { Auth, niceBackendFetch } from "../../../../../backend-helpers";

it("should create a new CLI auth attempt", async ({ expect }) => {
  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {},
  });

  expect(response.status).toBe(200);
  expect(response.body).toHaveProperty("polling_code");
  expect(response.body).toHaveProperty("login_code");
  expect(response.body).toHaveProperty("expires_at");

  // Verify that the expiration time is about 2 hours from now (default polling-code TTL)
  const expiresAt = new Date(response.body.expires_at);
  const now = new Date();
  const twoHoursInMs = 2 * 60 * 60 * 1000;
  expect(expiresAt.getTime() - now.getTime()).toBeGreaterThan(twoHoursInMs - 10000); // Allow for a small margin of error
  expect(expiresAt.getTime() - now.getTime()).toBeLessThan(twoHoursInMs + 10000); // Allow for a small margin of error
});

it("should accept the maximum expiration time of 24 hours", async ({ expect }) => {
  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {
      expires_in_millis: 24 * 60 * 60 * 1000,
    },
  });
  expect(response.status).toBe(200);
});

it("should reject an expiration time longer than 24 hours", async ({ expect }) => {
  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {
      expires_in_millis: 24 * 60 * 60 * 1000 + 1,
    },
  });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ code: "SCHEMA_ERROR" });
});

it("should create a new CLI auth attempt with custom expiration time", async ({ expect }) => {
  const customExpirationMs = 10 * 60 * 1000; // 10 minutes (max is 24 hours)

  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {
      expires_in_millis: customExpirationMs,
    },
  });

  expect(response.status).toBe(200);
  expect(response.body).toHaveProperty("polling_code");
  expect(response.body).toHaveProperty("login_code");
  expect(response.body).toHaveProperty("expires_at");

  // Verify that the expiration time is about the requested 10 minutes from now
  const expiresAt = new Date(response.body.expires_at);
  const now = new Date();
  expect(expiresAt.getTime() - now.getTime()).toBeGreaterThan(customExpirationMs - 10000); // Allow for a small margin of error
  expect(expiresAt.getTime() - now.getTime()).toBeLessThan(customExpirationMs + 10000); // Allow for a small margin of error
});

it("should create a CLI auth attempt with a valid anon_refresh_token", async ({ expect }) => {
  const anonUser = await Auth.Anonymous.signUp();

  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {
      anon_refresh_token: anonUser.refreshToken,
    },
  });

  expect(response.status).toBe(200);
  expect(response.body).toHaveProperty("polling_code");
  expect(response.body).toHaveProperty("login_code");
  expect(response.body).toHaveProperty("expires_at");
});

it("should reject an invalid anon_refresh_token", async ({ expect }) => {
  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {
      anon_refresh_token: "invalid-token-that-does-not-exist",
    },
  });

  expect(response.status).toBe(400);
  expect(response.body).toContain("Invalid anon refresh token");
});

it("should reject anon_refresh_token belonging to a non-anonymous user", async ({ expect }) => {
  const realUser = await Auth.fastSignUp();

  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "server",
    body: {
      anon_refresh_token: realUser.refreshToken,
    },
  });

  expect(response.status).toBe(400);
  expect(response.body).toContain("does not belong to an anonymous user");
});

it("should work with client access type", async ({ expect }) => {
  const response = await niceBackendFetch("/api/latest/auth/cli", {
    method: "POST",
    accessType: "client",
    body: {},
  });

  expect(response.status).toBe(200);
  expect(response.body).toHaveProperty("polling_code");
  expect(response.body).toHaveProperty("login_code");
  expect(response.body).toHaveProperty("expires_at");
});
