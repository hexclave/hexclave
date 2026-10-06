// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserResourceErrorSignal,
  installBrowserResourceErrorCapture,
  normalizeBrowserResourceUrl,
} from "./browser-resource-errors";
import { normalizeNetworkCaptureOptions } from "./network-capture";

afterEach(() => {
  document.body.replaceChildren();
});

function errorEventFor(element: Element): Event {
  const event = new Event("error");
  element.dispatchEvent(event);
  return event;
}

describe("browser resource error capture", () => {
  it("classifies script, stylesheet, image, and link failures with path-only URLs", () => {
    const networkCapture = normalizeNetworkCaptureOptions(undefined);

    const script = document.createElement("script");
    script.src = "https://cdn.example.test/assets/app.js?tenant=private#chunk";
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/styles/app.css?token=secret";
    const image = document.createElement("img");
    image.src = "https://images.example.test/avatars/user.png?email=private@example.test";
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = "https://cdn.example.test/favicon.ico?session=secret";

    expect(getBrowserResourceErrorSignal(errorEventFor(script), { networkCapture })).toEqual({
      resourceType: "script",
      url: "/assets/app.js",
    });
    expect(getBrowserResourceErrorSignal(errorEventFor(stylesheet), { networkCapture })).toEqual({
      resourceType: "style",
      url: "/styles/app.css",
    });
    expect(getBrowserResourceErrorSignal(errorEventFor(image), { networkCapture })).toEqual({
      resourceType: "image",
      url: "/avatars/user.png",
    });
    expect(getBrowserResourceErrorSignal(errorEventFor(link), { networkCapture })).toEqual({
      resourceType: "link",
      url: "/favicon.ico",
    });
  });

  it("uses fixed placeholders for non-HTTP resource schemes", () => {
    expect(normalizeBrowserResourceUrl("data:image/png;base64,private-bytes")).toBe("<data-url>");
    expect(normalizeBrowserResourceUrl("blob:https://app.example.test/secret-id")).toBe("<blob-url>");
    expect(normalizeBrowserResourceUrl("file:///Users/private/app.css")).toBe("<non-http-url>");
  });

  it("applies the existing network policy to the original URL before scrubbing it", () => {
    const script = document.createElement("script");
    script.src = "https://cdn.example.test/assets/app.js?private-query=1";

    expect(getBrowserResourceErrorSignal(errorEventFor(script), {
      networkCapture: normalizeNetworkCaptureOptions({ enabled: false }),
    })).toBeNull();
    expect(getBrowserResourceErrorSignal(errorEventFor(script), {
      networkCapture: normalizeNetworkCaptureOptions({ ignoreUrls: ["private-query=1"] }),
    })).toBeNull();
    expect(getBrowserResourceErrorSignal(errorEventFor(script), {
      networkCapture: normalizeNetworkCaptureOptions({ allowOrigins: ["https://other.example.test"] }),
    })).toBeNull();
    expect(getBrowserResourceErrorSignal(errorEventFor(script), {
      networkCapture: normalizeNetworkCaptureOptions({ denyOrigins: ["https://cdn.example.test"] }),
    })).toBeNull();
    expect(getBrowserResourceErrorSignal(errorEventFor(script), {
      networkCapture: normalizeNetworkCaptureOptions({ allowOrigins: ["https://cdn.example.test"] }),
    })).toEqual({ resourceType: "script", url: "/assets/app.js" });
  });

  it("listens in capture phase and removes exactly its own listener", () => {
    const handler = vi.fn();
    const uninstall = installBrowserResourceErrorCapture(handler, {
      networkCapture: normalizeNetworkCaptureOptions(undefined),
    });
    const script = document.createElement("script");
    script.src = "/assets/app.js?token=secret";
    document.body.append(script);

    script.dispatchEvent(new Event("error"));
    expect(handler).toHaveBeenCalledWith({ resourceType: "script", url: "/assets/app.js" });

    uninstall();
    script.dispatchEvent(new Event("error"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("ignores ordinary runtime errors and non-resource elements", () => {
    const button = document.createElement("button");
    expect(getBrowserResourceErrorSignal(new Event("error"), {
      networkCapture: normalizeNetworkCaptureOptions(undefined),
    })).toBeNull();
    expect(getBrowserResourceErrorSignal(errorEventFor(button), {
      networkCapture: normalizeNetworkCaptureOptions(undefined),
    })).toBeNull();
  });
});
