// Pure functions over a ServiceSpec that both the generic service logic and the runtime
// providers need. In their own module so a provider can import them without importing
// services.ts — which imports the providers, and a cycle there would leave one side's
// bindings undefined at module-evaluation time.
import { badRequest } from "./errors.js";
import { portEntries, type PortsConfig, type ServiceSpec, type VolumeConfig } from "./types.js";

/**
 * Whether the spec asks for public ingress. A property of the container, not of
 * any port.
 *
 * Compared against `true` rather than returned directly, despite the type: specs
 * live in the bucket, which no reset clears, and one written before `public`
 * existed has no such field. Such a spec reads as PRIVATE — the safe direction,
 * and it self-corrects on the next apply, which rewrites the spec from the
 * backend's definition.
 */
export function specIsPublic(spec: ServiceSpec): boolean {
  return spec.config.public === true;
}

/**
 * The one HTTP port a bare `url` can name, or null when the service leaves it
 * ambiguous (several HTTP ports) or impossible (none).
 */
export function soleHttpPort(ports: PortsConfig): number | null {
  const httpPorts = portEntries(ports).filter((entry) => entry.protocol === "http");
  return httpPorts.length === 1 ? httpPorts[0].port : null;
}

/**
 * The port that additionally answers on 80/443, or null when there is no single
 * obvious one.
 *
 * Defined for PRIVATE services too, not just public ones: a private service
 * gets public ingress the moment a custom domain is attached (see attachDomain),
 * and that domain terminates TLS on 443 — so a private service with one HTTP
 * port must bind the standard ports too, or its verified domain would resolve
 * and then refuse the connection.
 *
 * When a public service declares SEVERAL ports exactly one can hold 80/443, and it is the
 * LOWEST-NUMBERED — portEntries sorts numerically, so the winner is a property
 * of the port set rather than of JSON key ordering. Determinism is the point:
 * the holder is the port the service's bare URL names and the only one a custom
 * domain can front, so an arbitrary pick would silently move both. KEPT IN SYNC
 * WITH standardPortsHolderPort in @hexclave/shared's deployments.ts, which
 * is what the backend reports to the CLI and dashboard from.
 */
export function standardPortsHolderFor(ports: PortsConfig, isPublic: boolean): number | null {
  if (!isPublic) return soleHttpPort(ports);
  // Filtered to HTTP defensively: a public service may declare no TCP port, so
  // on any valid spec this is simply the lowest port.
  const httpPorts = portEntries(ports).filter((entry) => entry.protocol === "http");
  return httpPorts.length === 0 ? null : httpPorts[0].port;
}

/**
 * The port rule for a service that holds (or is about to hold) a custom domain.
 *
 * A custom domain gives the service public ingress, so it makes the service reachable
 * exactly the way `public: true` does — so a service holding one has to satisfy the same
 * rules a public service does, whether or not it declares itself public.
 *
 * On Fly, `services` are the proxy's listener set for the whole app with no per-address
 * scoping, so every declared port answers on every IP the app holds. A PRIVATE service with
 * an HTTP port next to a 5432 looks legal at sync time — nothing is public — but a domain
 * on it puts that 5432 on the internet. The GCP gateway is HTTP-only and cannot route a raw
 * port at all, so the same rule is what keeps the two runtimes' contracts identical.
 *
 * STRICTER THAN validateServiceSpec, and deliberately: that rule passes a wholly private
 * multi-port service, because a service nobody can reach leaks nothing. A domain is exactly
 * what makes it reachable, so at attach time those same siblings become the leak. The one
 * port a private service may front with a domain is its ONLY port — publishing it is what the
 * author asked the domain for. A PUBLIC service is fine at any port count: it is already
 * reachable, the domain simply fronts its standard-ports holder.
 *
 * BOTH places that can bring a domain and this port set together must call this: the attach
 * (domains.ts) and the spec write (applyServiceSpecWithLease). Checking only the attach
 * leaves the ports free to move afterwards — attach a domain to a lone HTTP port, then PUT a
 * `tcp` sibling, and the spec is legal at every gate while the proxy publishes it.
 * That is why this is one function and not a rule re-typed at each site.
 */
export function assertServiceCanHoldADomain(serviceKey: string, ports: PortsConfig, isPublic: boolean, remedy: string): void {
  const entries = portEntries(ports);
  if (!entries.some((entry) => entry.protocol === "http")) {
    throw badRequest(`custom domains need an HTTP port to route to; service ${JSON.stringify(serviceKey)} declares none. ${remedy}`);
  }
  if (!isPublic && entries.length > 1) {
    throw badRequest(`a private service holding a custom domain may not declare more than one port: the domain allocates public IPs, and the proxy serves every declared port on every address the app has, so the others would be published too. Service ${JSON.stringify(serviceKey)} declares ${entries.length} ports; make the service public, or move the others onto their own service and reach them with hostname(). ${remedy}`);
  }
  // The domain can only front the port that owns 80/443 — a certificate
  // terminates TLS there and nowhere else.
  if (standardPortsHolderFor(ports, isPublic) === null) {
    throw badRequest(`a custom domain needs one HTTP port to front, and service ${JSON.stringify(serviceKey)} leaves it ambiguous. ${remedy}`);
  }
}

// The spec's single persistent volume, or null. `persistent_volumes` is a record so the
// volume ID is a first-class key, but validateServiceSpec caps it at one entry, so every
// consumer wants exactly this.
export function specVolume(spec: ServiceSpec): { volumeId: string, volume: VolumeConfig } | null {
  const entries = Object.entries(spec.config.persistent_volumes ?? {});
  if (entries.length === 0) return null;
  return { volumeId: entries[0][0], volume: entries[0][1] };
}

/** A "server" pinned up: one instance that never autostops. */
export function isServerful(spec: ServiceSpec): boolean {
  return spec.config.min_instances === 1 && spec.config.max_instances === 1;
}

/** How many machines a Fly service holds (all of them exist; the unpinned ones autostop). */
export function desiredMachineCount(spec: ServiceSpec): number {
  return isServerful(spec) ? 1 : spec.config.max_instances;
}

/** How many of those never autostop. */
export function pinnedMachineCount(spec: ServiceSpec): number {
  return isServerful(spec) ? 1 : spec.config.min_instances;
}
