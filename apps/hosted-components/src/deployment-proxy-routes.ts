// These are Vercel Build Output API routes, prepended by Nitro before filesystem
// and application routing. A normal after-filesystem rewrite would accidentally
// serve hosted-component assets when a deployment uses the same pathname.
// The suffix is one DNS label and leaves room for "deploy-" within 63 characters.
export const deploymentProxyHostPattern = "^deploy-(?<appSuffix>[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?)\\.built-with-hexclave\\.com$";

export const deploymentProxyRoutes = [{
  src: "/(.*)",
  has: [{ type: "host", value: deploymentProxyHostPattern }] satisfies { type: "host", value: string }[],
  dest: "https://hxc-$appSuffix.fly.dev/$1",
  // Customer responses should not accidentally become cached auth pages or share
  // the hosted-components project's static asset caching policy.
  headers: { "x-vercel-enable-rewrite-caching": "0" },
}];
