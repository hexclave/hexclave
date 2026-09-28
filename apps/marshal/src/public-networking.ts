type PublicNetworkingFlyClient = {
  getAppIps(appName: string): Promise<{ sharedIpv4: string | null, dedicated: { id: string, type: string }[] }>,
  allocateIp(appName: string, type: "shared_v4" | "v6"): Promise<void>,
  releaseIpById(appName: string, ipAddressId: string): Promise<void>,
  releaseIpByAddress(appName: string, ip: string): Promise<void>,
  listCertificates(appName: string): Promise<unknown[]>,
};

/** Reconciles the public IPs that make Fly's built-in `<app>.fly.dev` endpoint routable. */
export async function ensurePublicIps(fly: PublicNetworkingFlyClient, appName: string): Promise<void> {
  const ips = await fly.getAppIps(appName);
  if (ips.sharedIpv4 === null) await fly.allocateIp(appName, "shared_v4");
  if (!ips.dedicated.some((ip) => ip.type === "v6")) await fly.allocateIp(appName, "v6");
}

/**
 * Removes public ingress only when neither service visibility nor a custom
 * domain needs it. Flycast remains allocated separately for private traffic.
 */
export async function releasePublicIpsIfUnused(fly: PublicNetworkingFlyClient, appName: string, publiclyVisible: boolean): Promise<void> {
  if (publiclyVisible || (await fly.listCertificates(appName)).length > 0) return;
  const ips = await fly.getAppIps(appName);
  if (ips.sharedIpv4 !== null) await fly.releaseIpByAddress(appName, ips.sharedIpv4);
  for (const ip of ips.dedicated) {
    if (ip.type === "v6") await fly.releaseIpById(appName, ip.id);
  }
}

export async function reconcilePublicIps(fly: PublicNetworkingFlyClient, appName: string, visibility: "public" | "private"): Promise<void> {
  if (visibility === "public") {
    await ensurePublicIps(fly, appName);
  } else {
    await releasePublicIpsIfUnused(fly, appName, false);
  }
}
