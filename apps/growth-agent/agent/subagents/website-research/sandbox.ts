import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { growthSandboxBackend } from "#lib/sandbox-backend.ts";

// Declared subagents do NOT share the root sandbox. Hosted and local
// development currently use the SSRF-hardened Vercel network policy. Website
// research needs public network access, while the microVM firewall denies
// loopback, RFC1918, link-local, CGNAT, and "this network" ranges.
//
// Deployment note: this subnet denylist covers IPv4 private ranges. If the
// Hexclave backend (HEXCLAVE_GROWTH_BACKEND_URL) is reachable on a *public*
// address, the sandbox can technically reach it, but holds no credentials --
// the machine secret only exists in the app runtime where the authored tools
// run, and eve's credential model keeps secrets out of the sandbox -- so such
// requests fail authentication. Operators terminating the backend on an
// internal IPv6 range should extend the denylist accordingly.
export default defineSandbox({
  backend: growthSandboxBackend({
    docker: { networkPolicy: "allow-all" },
    vercel: {
      networkPolicy: {
        allow: { "*": [] },
        subnets: {
          deny: [
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.168.0.0/16",
          ],
        },
      },
    },
  }),
  // Chromium and its system libraries are template state. Installing them in
  // bootstrap makes every child session start browser-ready without paying an
  // install or separate-VM cost for each page.
  revalidationKey: () => `website-research:${agentBrowserRevalidationKey()}`,
  async bootstrap({ use }) {
    await installAgentBrowser(await use());
  },
});
