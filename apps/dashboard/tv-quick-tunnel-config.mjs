const QUICK_TUNNEL_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

function parseExactQuickTunnelOrigin(configuredOrigin) {
  let parsed;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error("HEXCLAVE_TV_QUICK_TUNNEL_ORIGIN must be one exact HTTPS trycloudflare.com origin.");
  }

  if (
    configuredOrigin !== parsed.origin
    || parsed.protocol !== "https:"
    || parsed.port !== ""
    || !QUICK_TUNNEL_HOSTNAME_PATTERN.test(parsed.hostname)
  ) {
    throw new Error("HEXCLAVE_TV_QUICK_TUNNEL_ORIGIN must be one exact HTTPS trycloudflare.com origin without a wildcard, port, path, query, or fragment.");
  }

  return parsed;
}

/**
 * Builds the narrowly scoped development transport needed to open `/tv` through
 * one ephemeral Cloudflare Quick Tunnel. Keeping this behind an explicit
 * server-only opt-in prevents the public hostname and same-origin API proxy from
 * changing normal development or any production build.
 */
export function resolveTvQuickTunnelDevelopmentConfig({
  configuredOrigin,
  nodeEnvironment,
  portPrefix,
  useFallbackBackend,
}) {
  if (configuredOrigin === undefined) return null;
  if (nodeEnvironment !== "development") {
    throw new Error("HEXCLAVE_TV_QUICK_TUNNEL_ORIGIN is only allowed with the Next.js development server.");
  }

  const origin = parseExactQuickTunnelOrigin(configuredOrigin);
  const backendPortSuffix = useFallbackBackend ? "10" : "02";
  const backendOrigin = `http://127.0.0.1:${portPrefix}${backendPortSuffix}`;

  return {
    allowedDevOrigins: [origin.hostname],
    rewrites: [
      {
        source: "/api/latest/tv-displays/:path*",
        destination: `${backendOrigin}/api/latest/tv-displays/:path*`,
      },
    ],
  };
}
