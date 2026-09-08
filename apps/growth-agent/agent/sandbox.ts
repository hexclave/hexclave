import { defineSandbox } from "eve/sandbox";
import { growthSandboxBackend } from "#lib/sandbox-backend.ts";


export default defineSandbox({
  backend: growthSandboxBackend({
    docker: { networkPolicy: "deny-all" },
    vercel: {},
  }),
});
