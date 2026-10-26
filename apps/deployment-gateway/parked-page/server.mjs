// The page a STOPPED deployment serves.
//
// When a deployment is parked (see parkService in apps/marshal/src/services.ts),
// Marshal rolls the service's machines onto this image instead of the tenant's
// own. Everything else about the service is left alone: same app, same ports,
// same IPs, same certificates, same disks. So this page answers on the
// deployment's platform hostname AND on every custom domain attached to it, and
// unparking is just a roll back onto the tenant image.
//
// Deliberately dependency-free and configuration-free. The only thing that
// varies per service is PORT (the service's standard-ports holder, which is what
// Fly maps 80/443 onto), and the only thing that varies per park is the reason.
// Everything else, the dashboard link included, is a constant — which is what
// lets one published image serve every parked service in the fleet.
import { createServer } from "node:http";

// No project id in the link, deliberately. This page is public: anyone who
// visits a parked deployment sees it, and the project selector gets the owner
// where they are going without publishing which Hexclave project backs this
// domain to everyone else who happens to look.
const OWNER_URL = "https://app.hexclave.com/projects/-selector-/deployments";

// The one reason a deployment is parked today. Other reasons (a platform pause,
// an abuse suspension) get their own entry here rather than their own image;
// UNKNOWN_REASON_COPY is what an image older than a new reason falls back to, so
// adding one can never render an empty page.
const REASON_COPY = {
  free_plan_24h: {
    heading: "Are you the owner of this site?",
    body: "Sites on the Free plan stop running 24 hours after each deploy. Upgrade to the Team plan to remove this limit.",
  },
};

const UNKNOWN_REASON_COPY = {
  heading: "Are you the owner of this site?",
  body: "This site has been stopped. Open Hexclave to see why and to start it again.",
};

const VISITOR_HEADING = "This site isn’t available right now";
const VISITOR_BODY = "If you were trying to reach something here, please contact the owner of this site.";

export function copyForReason(reason) {
  return Object.hasOwn(REASON_COPY, reason) ? REASON_COPY[reason] : UNKNOWN_REASON_COPY;
}

/**
 * HTML only when the client actually asked for it, JSON only when it actually
 * asked for that, and plain text for everything else.
 *
 * A wildcard Accept (curl's default, and what most API clients send) therefore
 * lands on text rather than on a wall of markup: the reader there is a person at
 * a terminal or a log, and neither wants a stylesheet.
 */
export function negotiate(accept) {
  const header = (accept ?? "").toLowerCase();
  if (header.includes("text/html")) return "html";
  if (header.includes("application/json") || header.includes("+json")) return "json";
  return "text";
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHtml(reason) {
  const owner = copyForReason(reason);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Site unavailable</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68; --line: #e4e4e1; --card: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #191918; --fg: #ededec; --muted: #a1a1a0; --line: #2e2e2c; --card: #211f1e; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 32rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 32px; }
  h1 { margin: 0 0 12px; font-size: 20px; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; }
  h2 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
  p { margin: 0; color: var(--muted); }
  section { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); }
  a.action { display: inline-block; margin-top: 14px; color: inherit; font-weight: 500; text-decoration: none; border-bottom: 1px solid var(--muted); padding-bottom: 1px; }
  a.action:hover { border-bottom-color: currentColor; }
  footer { margin-top: 28px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(VISITOR_HEADING)}</h1>
  <p>${escapeHtml(VISITOR_BODY)}</p>
  <section>
    <h2>${escapeHtml(owner.heading)}</h2>
    <p>${escapeHtml(owner.body)}</p>
    <a class="action" href="${escapeHtml(OWNER_URL)}">Open Hexclave &rarr;</a>
  </section>
  <footer>Powered by Hexclave</footer>
</main>
</body>
</html>
`;
}

export function renderJson(reason) {
  return `${JSON.stringify({
    error: "site_unavailable",
    reason,
    message: VISITOR_BODY,
    owner_url: OWNER_URL,
  }, null, 2)}\n`;
}

export function renderText(reason) {
  const owner = copyForReason(reason);
  return [VISITOR_HEADING, "", VISITOR_BODY, "", owner.heading, owner.body, "", OWNER_URL, ""].join("\n");
}

/**
 * The whole response, for any request.
 *
 * 503 rather than 402 or 404: a parked deployment is temporarily not serving,
 * and 503 is the one status search engines treat as "come back later, keep this
 * site's ranking". A custom domain pointed at a parked service would otherwise
 * be deindexed for being stopped overnight. `Retry-After` is deliberately
 * omitted — nothing here comes back on a timer, only when someone acts.
 *
 * `no-store` matters more than it looks: a CDN in front of a custom domain that
 * cached this page would keep serving it after the owner upgraded, which is the
 * one bug that would make this feature look broken rather than strict.
 */
export function responseFor({ method = "GET", accept, reason }) {
  const format = negotiate(accept);
  const body = format === "html" ? renderHtml(reason) : format === "json" ? renderJson(reason) : renderText(reason);
  const contentType = format === "html" ? "text/html; charset=utf-8" : format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  return {
    status: 503,
    headers: {
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      // Machine-readable, for anyone debugging why a domain answers this way.
      "x-hexclave-deployment-stopped": reason,
    },
    // Every method is answered, HEAD included: this replaces a whole application,
    // so there is no path or verb it may 404 or 405 on.
    body: method === "HEAD" ? "" : body,
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got ${JSON.stringify(value)}`);
  }
  return port;
}

export function createParkedServer(reason) {
  return createServer((request, response) => {
    const { status, headers, body } = responseFor({ method: request.method, accept: request.headers.accept, reason });
    response.writeHead(status, headers);
    response.end(body);
  });
}

// Skipped when the module is imported by a test.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const port = parsePort(process.env.PORT ?? "8080");
  const reason = process.env.HEXCLAVE_PARKED_REASON ?? "free_plan_24h";
  createParkedServer(reason).listen(port, "0.0.0.0", () => {
    console.log(`parked page listening on ${port} (reason: ${reason})`);
  });
}
