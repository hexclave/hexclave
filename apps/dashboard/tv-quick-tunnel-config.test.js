import { describe, expect, it } from "vitest";
import { resolveTvQuickTunnelDevelopmentConfig } from "./tv-quick-tunnel-config.mjs";

const defaultOptions = {
  nodeEnvironment: "development",
  portPrefix: "81",
  useFallbackBackend: false,
};

describe("TV Quick Tunnel development configuration", () => {
  it("is completely disabled when the opt-in is absent", () => {
    expect(resolveTvQuickTunnelDevelopmentConfig({
      ...defaultOptions,
      configuredOrigin: undefined,
    })).toBeNull();
  });

  it("allows one exact Quick Tunnel hostname and only the TV-display API prefix", () => {
    expect(resolveTvQuickTunnelDevelopmentConfig({
      ...defaultOptions,
      configuredOrigin: "https://phase-one-box.trycloudflare.com",
    })).toEqual({
      allowedDevOrigins: ["phase-one-box.trycloudflare.com"],
      rewrites: [
        {
          source: "/api/latest/tv-displays/:path*",
          destination: "http://127.0.0.1:8102/api/latest/tv-displays/:path*",
        },
      ],
    });
  });

  it("respects the custom port prefix and fallback-backend convention", () => {
    expect(resolveTvQuickTunnelDevelopmentConfig({
      configuredOrigin: "https://phase-one-box.trycloudflare.com",
      nodeEnvironment: "development",
      portPrefix: "93",
      useFallbackBackend: true,
    })?.rewrites).toEqual([
      {
        source: "/api/latest/tv-displays/:path*",
        destination: "http://127.0.0.1:9310/api/latest/tv-displays/:path*",
      },
    ]);
  });

  it.each([
    "",
    "http://phase-one-box.trycloudflare.com",
    "https://*.trycloudflare.com",
    "https://trycloudflare.com",
    "https://nested.phase-one-box.trycloudflare.com",
    "https://phase-one-box.trycloudflare.com/",
    "https://phase-one-box.trycloudflare.com/tv",
    "https://phase-one-box.trycloudflare.com?test=true",
    "https://phase-one-box.trycloudflare.com:8443",
    "https://phase-one-box.example.com",
  ])("rejects a non-exact Quick Tunnel origin: %s", (configuredOrigin) => {
    expect(() => resolveTvQuickTunnelDevelopmentConfig({
      ...defaultOptions,
      configuredOrigin,
    })).toThrowError(/one exact HTTPS trycloudflare\.com origin/);
  });

  it.each(["production", "test", undefined])("cannot activate under NODE_ENV=%s", (nodeEnvironment) => {
    expect(() => resolveTvQuickTunnelDevelopmentConfig({
      ...defaultOptions,
      configuredOrigin: "https://phase-one-box.trycloudflare.com",
      nodeEnvironment,
    })).toThrowError(/only allowed with the Next\.js development server/);
  });
});
