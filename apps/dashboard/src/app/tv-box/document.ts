import type { TvSnapshot } from "@/lib/tv-mode/types";

type TvBoxApiConfiguration =
  | { mode: "browser-origin" }
  | { mode: "configured", apiBaseUrl: string };

type TvBoxDocumentOptions =
  | { mode: "live", api: TvBoxApiConfiguration }
  | { mode: "fixture-preview", snapshot: TvSnapshot };

function serializeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function resolveTvBoxApiConfiguration(options: {
  configuredApiUrl: string | undefined,
  configuredBrowserApiUrl: string | undefined,
  nodeEnvironment: string | undefined,
  quickTunnelEnabled: boolean,
}): TvBoxApiConfiguration {
  if (options.quickTunnelEnabled) {
    if (options.nodeEnvironment !== "development") {
      throw new Error("The TV Box Quick Tunnel transport cannot be used outside development.");
    }
    // Cloudflare may replace the Host header before this route renders. Let the
    // browser supply the already-validated public origin instead of reconstructing
    // it server-side or embedding a localhost API URL that points back to the box.
    return { mode: "browser-origin" };
  }

  const configuredBase = options.configuredBrowserApiUrl ?? options.configuredApiUrl;
  if (configuredBase == null) throw new Error("TV Box display API URL is not configured.");
  return { mode: "configured", apiBaseUrl: configuredBase };
}

export function createTvBoxDocument(options: TvBoxDocumentOptions): string {
  const config = serializeJsonForHtml(options);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="color-scheme" content="dark">
    <title>Hexclave TV Box</title>
    <link rel="stylesheet" href="/tv-box/tv-box.css">
  </head>
  <body>
    <main id="tv-box-root" class="tv-app">
      <div id="tv-box-celebration-background" class="tv-celebration-layer tv-celebration-background" aria-hidden="true"></div>
      <div id="tv-box-stage" class="tv-stage-root" aria-live="polite"></div>
      <div id="tv-box-celebration-foreground" class="tv-celebration-layer tv-celebration-foreground" aria-hidden="true"></div>
      <div id="tv-box-footer" class="tv-footer-host"></div>
      <div id="tv-box-controls" class="tv-controls-host"></div>
    </main>
    <script id="tv-box-config" type="application/json">${config}</script>
    <script type="module" src="/tv-box/app.mjs"></script>
  </body>
</html>`;
}
