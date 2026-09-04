import { withSentryConfig } from "@sentry/nextjs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveTvQuickTunnelDevelopmentConfig } from "./tv-quick-tunnel-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isRdeBuild = process.env.HEXCLAVE_DASHBOARD_BUILD_FOR_RDE === "true";
const tvQuickTunnelConfig = resolveTvQuickTunnelDevelopmentConfig({
  configuredOrigin: process.env.HEXCLAVE_TV_QUICK_TUNNEL_ORIGIN,
  nodeEnvironment: process.env.NODE_ENV,
  portPrefix: process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81",
  useFallbackBackend: process.env.STACK_DEV_FALLBACK_BACKEND != null,
});

const withConfiguredSentryConfig = (nextConfig) =>
  withSentryConfig(
    nextConfig,
    {
      // For all available options, see:
      // https://github.com/getsentry/sentry-webpack-plugin#options

      org: "stackframe-pw",
      project: "stack-server",

      widenClientFileUpload: true,
      telemetry: false,
    },
    {
      // For all available options, see:
      // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

      // Upload a larger set of source maps for prettier stack traces (increases build time)
      widenClientFileUpload: true,

      // Transpiles SDK to be compatible with IE11 (increases bundle size)
      transpileClientSDK: true,

      // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
      // This can increase your server load as well as your hosting bill.
      // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
      // side errors will fail.
      tunnelRoute: "/monitoring",

      // Hides source maps from generated client bundles
      hideSourceMaps: true,

      // RDE artifacts do not ship browser source maps. Hosted and self-host
      // builds continue generating and uploading them to Sentry.
      sourcemaps: {
        disable: isRdeBuild,
      },

      // Automatically tree-shake Sentry logger statements to reduce bundle size
      disableLogger: true,

      // Enables automatic instrumentation of Vercel Cron Monitors.
      // See the following for more information:
      // https://docs.sentry.io/product/crons/
      // https://vercel.com/docs/cron-jobs
      automaticVercelMonitors: true,
    }
  );

function resolveHexclaveStackEnvVar(hexclaveName, stackName) {
  const hexclaveValue = process.env[hexclaveName];
  const stackValue = process.env[stackName];
  if (hexclaveValue && stackValue && hexclaveValue !== stackValue) {
    throw new Error(`Environment variables ${hexclaveName} and ${stackName} are both set to different values. Remove one of them or set them to the same value.`);
  }
  return hexclaveValue || stackValue || undefined;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // optionally set output to "standalone" for Docker builds
  // https://nextjs.org/docs/pages/api-reference/next-config-js/output
  output: process.env.NEXT_CONFIG_OUTPUT,
  distDir: process.env.HEXCLAVE_DASHBOARD_NEXT_DIST_DIR,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The claude-agent-sdk spawns cli.js as a child process (resolved via
  // import.meta.url). Keeping it external ensures the entire package directory
  // is included in the standalone trace, so cli.js, vendor/, etc. survive
  // .pnpm removal.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],

  pageExtensions: ["js", "jsx", "mdx", "ts", "tsx"],

  cacheComponents: true,

  // we're open-source, so we can provide source maps — but skip them for
  // RDE standalone builds where they just take up space for no reason
  productionBrowserSourceMaps: process.env.NEXT_CONFIG_OUTPUT !== "standalone",

  poweredByHeader: false,

  ...(tvQuickTunnelConfig == null ? {} : {
    allowedDevOrigins: tvQuickTunnelConfig.allowedDevOrigins,
    env: {
      NEXT_PUBLIC_HEXCLAVE_TV_QUICK_TUNNEL_ENABLED: "true",
    },
  }),

  experimental: {
    turbopackFileSystemCacheForDev: true,
  },

  typescript: {
    ignoreBuildErrors: process.env.STACK_NEXT_CONFIG_DISABLE_TYPESCRIPT === "true",
  },

  images: {
    // Disable image optimization in standalone/RDE builds to avoid shipping
    // the sharp native binary (~17 MB). The RDE runs locally so optimized
    // images are not needed.
    ...(process.env.NEXT_CONFIG_OUTPUT === "standalone" ? { unoptimized: true } : {}),
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.featurebase-attachments.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'raw.githubusercontent.com',
        port: '',
        pathname: '/**',
      },
    ],
  },

  async rewrites() {
    return [
      ...(tvQuickTunnelConfig?.rewrites ?? []),
      {
        source: "/consume/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/consume/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
      {
        source: "/consume/decide",
        destination: "https://eu.i.posthog.com/decide",
      },
    ];
  },

  async headers() {
    // The development-environment (RDE) dashboard is embedded as an iframe by the
    // dev tool overlay, which runs inside the customer's own app on a *different*
    // localhost origin (e.g. http://localhost:3000). A plain X-Frame-Options:
    // SAMEORIGIN would block that framing, so RDE builds instead scope framing to
    // localhost origins via CSP frame-ancestors. This only applies to the RDE
    // build target (build:rde-standalone / dev:rde-production); the hosted and
    // self-host Docker builds keep X-Frame-Options: SAMEORIGIN.
    const allowsFraming = isRdeBuild || resolveHexclaveStackEnvVar("NEXT_PUBLIC_HEXCLAVE_IS_PREVIEW", "NEXT_PUBLIC_STACK_IS_PREVIEW") === "true";
    const rdeFrameAncestors = "frame-ancestors 'self' http://localhost:* https://localhost:* http://*.localhost:* https://*.localhost:* http://127.0.0.1:* https://127.0.0.1:* http://[::1]:* https://[::1]:*";
    return [
      {
        source: "/(.*)",
        headers: [
          {
            // needed for stripe connect embedded components
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          {
            key: "Permissions-Policy",
            value: "",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          ...allowsFraming ? [] : [{
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          }],
          {
            key: "Content-Security-Policy",
            // Note: *.localhost requires Chrome 117+ and may not work in Firefox
            // without network.dns.localDomains configuration. Fine for dev tool purposes.
            value: isRdeBuild ? rdeFrameAncestors : "",
          },
        ],
      },
    ];
  },
};

export default withConfiguredSentryConfig(
  nextConfig
);
