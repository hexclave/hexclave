import "server-only";

import { StackServerApp } from "@hexclave/next";

export const hexclaveServerApp = new StackServerApp({
  tokenStore: "nextjs-cookie",
});
Object.assign(hexclaveServerApp, { __DEMO_ENABLE_SLIGHT_FETCH_DELAY: true });
