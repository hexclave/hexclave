import { it } from "../../../../../../helpers";
import { Project, backendContext, niceBackendFetch } from "../../../../../backend-helpers";

it("saves a trusted port wildcard and applies it to sign-in callbacks", async ({ expect }) => {
  const { adminAccessToken } = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const trustedDomain = { baseUrl: "https://*.example.com:*", handlerPath: "/handler" };
  const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
    method: "PATCH",
    accessType: "admin",
    headers: { "x-stack-admin-access-token": adminAccessToken },
    body: {
      config_override_string: JSON.stringify({
        "domains.allowLocalhost": false,
        "domains.trustedDomains.wildcard-port": trustedDomain,
      }),
    },
  });
  expect(configResponse.status).toBe(200);

  const savedConfig = await niceBackendFetch("/api/v1/internal/config", {
    accessType: "admin",
    headers: { "x-stack-admin-access-token": adminAccessToken },
  });
  expect(savedConfig.status).toBe(200);
  expect(JSON.parse(savedConfig.body.config_string).domains.trustedDomains["wildcard-port"]).toEqual(trustedDomain);

  const validResponse = await niceBackendFetch("/api/v1/auth/otp/send-sign-in-code", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      callback_url: "https://app.example.com:4405/handler",
    },
  });
  expect(validResponse.status).toBe(200);

  for (const callbackUrl of [
    "http://app.example.com:4405/handler",
    "https://example.com:4405/handler",
    "https://nested.app.example.com:4405/handler",
    "https://app.example.com.example.org:4405/handler",
  ]) {
    const response = await niceBackendFetch("/api/v1/auth/otp/send-sign-in-code", {
      method: "POST",
      accessType: "client",
      body: { email: backendContext.value.mailbox.emailAddress, callback_url: callbackUrl },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("REDIRECT_URL_NOT_WHITELISTED");
  }
});
