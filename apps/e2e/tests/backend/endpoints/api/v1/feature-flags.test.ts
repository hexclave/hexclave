import { it } from "../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../backend-helpers";

const featureFlagsConfig = {
  flags: {
    checkout_flag: {
      key: "new-checkout",
      type: "boolean",
      enabled: true,
      allocationSalt: "checkout-v1",
      fallbackVariantKey: "off",
      variants: {
        on: { value: true },
        off: { value: false },
      },
      rules: {
        verified_email: {
          priority: 10,
          variantKey: "on",
          conditions: {
            email: { attribute: "user.primary_email_verified", operator: "eq", value: true },
          },
        },
      },
    },
  },
};

async function enableFeatureFlags() {
  await Project.updateConfig({
    apps: { installed: { "feature-flags": { enabled: true } } },
    featureFlags: featureFlagsConfig,
  });
}

it("rejects invalid cross-references before publishing config", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/latest/internal/config/override/environment", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config_override_string: JSON.stringify({
        featureFlags: {
          flags: {
            broken: {
              key: "broken",
              type: "boolean",
              allocationSalt: "stable",
              fallbackVariantKey: "missing",
              variants: { off: { value: false } },
            },
          },
        },
      }),
    },
  });
  expect(response.status).toBe(400);
  expect(JSON.stringify(response.body)).toContain("missing fallback variant");

  const storedOverride = await niceBackendFetch("/api/latest/internal/config/override/environment", {
    method: "GET",
    accessType: "admin",
  });
  expect(JSON.parse(storedOverride.body.config_string).featureFlags).toBeUndefined();
});

it("requires the feature flags app to be installed", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/v1/feature-flags/evaluate", {
    method: "POST",
    accessType: "client",
    body: { flag_keys: ["new-checkout"], fallbacks: { "new-checkout": false } },
  });
  expect(response.status).toBe(400);
  expect(response.body).toBe("Feature flags are not enabled for this project.");
});

it("accepts minimal evaluate and tester bodies without optional context maps", async ({ expect }) => {
  await Project.createAndSwitch();
  await enableFeatureFlags();

  const publicResponse = await niceBackendFetch("/api/v1/feature-flags/evaluate", {
    method: "POST",
    accessType: "client",
    body: { flag_keys: ["new-checkout"] },
  });
  expect(publicResponse.status).toBe(200);
  expect(publicResponse.body?.results?.["new-checkout"]).toMatchObject({ value: false, variant_key: "off" });

  const testerResponse = await niceBackendFetch("/api/latest/internal/feature-flags/test", {
    method: "POST",
    accessType: "admin",
    body: { flag_keys: ["new-checkout"] },
  });
  expect(testerResponse.status).toBe(200);
  expect(testerResponse.body?.results?.["new-checkout"]).toMatchObject({ value: false, variant_key: "off", exposure_token: null });
});

it("uses verified auth attributes and ignores client-supplied user targeting data", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await enableFeatureFlags();
  await Auth.Otp.signIn();

  const verified = await niceBackendFetch("/api/v1/feature-flags/evaluate", {
    method: "POST",
    accessType: "client",
    body: { flag_keys: ["new-checkout"], fallbacks: { "new-checkout": false } },
  });
  expect(verified.body?.results?.["new-checkout"]).toMatchObject({ value: true, variant_key: "on", reason: "matched_rule", exposure_token: null });

  const spoofed = await niceBackendFetch("/api/v1/feature-flags/evaluate", {
    method: "POST",
    accessType: "client",
    userAuth: {},
    body: {
      flag_keys: ["new-checkout", "missing"],
      fallbacks: { "new-checkout": false, missing: "safe" },
      user: { primary_email_verified: true },
    },
  });
  expect(spoofed.body?.results).toMatchObject({
    "new-checkout": { value: false, variant_key: "off", reason: "fallback" },
    missing: { value: "safe", variant_key: null, reason: "missing" },
  });
});

it("protects bootstrap definitions and supports ETag revalidation", async ({ expect }) => {
  await Project.createAndSwitch();
  await enableFeatureFlags();

  const clientResponse = await niceBackendFetch("/api/v1/feature-flags/bootstrap", { method: "GET", accessType: "client" });
  expect(clientResponse.status).toBe(401);

  const first = await niceBackendFetch("/api/v1/feature-flags/bootstrap", { method: "GET", accessType: "server" });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ flag_ids_by_key: { "new-checkout": "checkout_flag" }, config_version: expect.any(String) });
  const etag = first.headers.get("etag");
  expect(etag).not.toBeNull();

  const revalidated = await niceBackendFetch("/api/v1/feature-flags/bootstrap", {
    method: "GET",
    accessType: "server",
    headers: { "if-none-match": etag ?? undefined },
  });
  expect(revalidated.status).toBe(304);
});
