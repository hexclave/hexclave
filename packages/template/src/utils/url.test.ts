import { afterEach, describe, expect, it } from "vitest";
import { constructRedirectUrl } from "./url";

const previousWindow = globalThis["window"];
const hadPreviousWindow = Reflect.has(globalThis, "window");

afterEach(() => {
  if (hadPreviousWindow) {
    Reflect.set(globalThis, "window", previousWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("constructRedirectUrl", () => {
  it("transports the complete cross-domain return state to an email callback", () => {
    const currentUrl = new URL("https://hosted.example.test/handler/forgot-password");
    currentUrl.searchParams.set("after_auth_return_to", "https://customer.example.test/handler/oauth-callback?hexclave_cross_domain_auth=1");
    currentUrl.searchParams.set("hexclave_cross_domain_state", "outer-state");
    currentUrl.searchParams.set("hexclave_cross_domain_code_challenge", "outer-challenge");
    currentUrl.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", "https://customer.example.test/dashboard");
    Reflect.set(globalThis, "window", {
      location: {
        href: currentUrl.toString(),
      },
    });

    const callbackUrl = new URL(constructRedirectUrl("/handler/password-reset#discarded", "callbackUrl"));

    expect(callbackUrl.toString()).toBe(
      "https://hosted.example.test/handler/password-reset"
      + "?after_auth_return_to=https%3A%2F%2Fcustomer.example.test%2Fhandler%2Foauth-callback%3Fhexclave_cross_domain_auth%3D1"
      + "&hexclave_cross_domain_state=outer-state"
      + "&hexclave_cross_domain_code_challenge=outer-challenge"
      + "&hexclave_cross_domain_after_callback_redirect_url=https%3A%2F%2Fcustomer.example.test%2Fdashboard",
    );
  });

  it("does not synthesize the forgot-password page as a return target", () => {
    Reflect.set(globalThis, "window", {
      location: {
        href: "https://hosted.example.test/handler/forgot-password",
      },
    });

    expect(constructRedirectUrl("/handler/password-reset", "callbackUrl")).toBe(
      "https://hosted.example.test/handler/password-reset",
    );
  });
});
