// Resolves a spec's `{ ref }` env values against the addresses of the services they name.
// Its own module because both the generic layer (services.ts) and a provider's domain flow
// need it, and a provider must not import services.ts (which imports the providers).
import { providerForNamespace, type RuntimeAddress } from "./provider.js";
import { soleHttpPort, standardPortsHolderFor } from "./spec-helpers.js";
import { readSpec } from "./store.js";
import { portEntries, type EnvValue, type PortsConfig, type ServiceKind } from "./types.js";

// The optional `:<port>` suffix belongs to `url`, which names the port it means
// on a service that declares several.
export const REF_REGEX = /^([a-zA-Z0-9_][a-zA-Z0-9_-]*)\.([A-Za-z0-9_]+)(?::([0-9]{1,5}))?$/;

// What a `url` reference needs to know about its target: which ports it declares
// and whether the SERVICE is public. Kept as one value so the two can never be
// sourced from different places — see targetOf.
export type KnownTarget = { type: ServiceKind, ports: PortsConfig, public: boolean };

export type ResolvedEnv =
  | { ok: true, env: Record<string, string> }
  | { ok: false, blockedRefs: string[] };

// `hostname` and `url` both come from the target's runtime ADDRESS, which the provider
// answers: on Fly a pure function of the service name, so it never blocks; on GCP the
// target's rollout, so it blocks until there is one. `url` names ONE port, so it needs to
// know that port's protocol and whether it is public — from the deployment's own targets
// when the target is part of this deploy (which is what keeps a private url() from
// depending on deploy ORDER), and otherwise from the target's stored spec.
export async function resolveEnv(ns: string, env: Record<string, EnvValue>, knownTargets?: Map<string, KnownTarget>): Promise<ResolvedEnv> {
  const resolved = new Map<string, string>();
  const blockedRefs: string[] = [];
  const addressCache = new Map<string, RuntimeAddress | null>();
  const targetCache = new Map<string, KnownTarget | null>();
  // Ports AND visibility together: they are two halves of one decision (which
  // address a `url` resolves to), so reading them from different places lets a
  // service being flipped public→private in this very deploy resolve as public
  // for a sibling applied before it.
  const targetOf = async (targetKey: string): Promise<KnownTarget | null> => {
    const known = knownTargets?.get(targetKey);
    if (known !== undefined) return known;
    if (!targetCache.has(targetKey)) {
      const spec = await readSpec(ns, targetKey);
      targetCache.set(targetKey, spec === null ? null : { type: spec.spec.config.type, ports: spec.spec.config.ports, public: spec.spec.config.public });
    }
    return targetCache.get(targetKey) ?? null;
  };
  const provider = await providerForNamespace(ns);
  const addressOf = async (targetKey: string): Promise<RuntimeAddress | null> => {
    if (!addressCache.has(targetKey)) {
      const stored = await readSpec(ns, targetKey);
      addressCache.set(targetKey, stored === null ? null : await provider.address(ns, targetKey, stored));
    }
    return addressCache.get(targetKey) ?? null;
  };
  // A target that has no stored spec yet (a sibling later in this deploy, or one never
  // deployed) still has a private host on a runtime that derives it from the name.
  const privateHostOf = async (targetKey: string): Promise<string | null> => {
    return (await addressOf(targetKey))?.privateHost ?? provider.staticPrivateHost(ns, targetKey);
  };

  for (const [key, value] of Object.entries(env)) {
    if ("value" in value) {
      resolved.set(key, value.value);
      continue;
    }
    const match = REF_REGEX.exec(value.ref);
    if (match === null) {
      blockedRefs.push(value.ref);
      continue;
    }
    const [, targetKey, outputKey, namedPortText] = match;
    // Truthiness, not an undefined check: TS types an optional capture group as
    // `string` even though it is undefined at run time when it did not match.
    const namedPort = namedPortText ? Number(namedPortText) : null;
    switch (outputKey) {
      case "hostname": {
        if (await targetOf(targetKey) === null) {
          blockedRefs.push(value.ref);
          break;
        }
        const hostname = (await addressOf(targetKey))?.hostname ?? provider.staticPrivateHost(ns, targetKey);
        if (hostname === null) blockedRefs.push(value.ref);
        else resolved.set(key, hostname);
        break;
      }
      case "url": {
        // Which port the URL means, and what it looks like. The port picks the
        // number; the TARGET SERVICE's visibility picks the address:
        //  - a PUBLIC service resolves to its public URL (the platform URL, or a
        //    verified custom domain), which exists only once the service is up;
        //  - a PRIVATE service resolves to its internal address, built from the
        //    target's private host and the port itself.
        const target = await targetOf(targetKey);
        if (target === null) {
          // Nothing known about the target: it may not have been deployed yet.
          blockedRefs.push(value.ref);
          break;
        }
        const ports = target.ports;
        const port = namedPort === null
          ? (() => {
            const sole = soleHttpPort(ports);
            return sole === null ? null : portEntries(ports).find((entry) => entry.port === sole) ?? null;
          })()
          : portEntries(ports).find((entry) => entry.port === namedPort) ?? null;
        if (port === null || port.protocol !== "http") {
          // The backend rejects both of these up front against the synced
          // definition; blocking rather than guessing means a spec that somehow
          // arrives unresolvable never deploys a container pointed at the wrong
          // port.
          blockedRefs.push(value.ref);
          break;
        }
        // Visibility is the TARGET SERVICE's, not the port's. Read from `target`,
        // which prefers this deployment's own specs — see targetOf. Reading it
        // from the STORED spec instead reintroduced exactly the deploy-order
        // dependence knownTargets exists to remove.
        const address = await addressOf(targetKey);
        if (!target.public) {
          // A PRIVATE address already carries the port it is reached on, so it is
          // finished here — it must NOT fall through to the standard-ports suffix
          // below, which exists only for a public URL that carries no port at all.
          // Letting it through appended the number a second time and handed the
          // consumer "http://10.128.0.21:9090:9090".
          //
          // `privateHost` is the host to build `http://host:port` on; when the
          // runtime hands out one port-agnostic endpoint instead (Cloud Run), it is
          // null and `internalUrl` is the whole answer.
          const privateHost = await privateHostOf(targetKey);
          const privateUrl = privateHost !== null
            ? `http://${privateHost}:${port.port}`
            : address?.internalUrl ?? null;
          if (privateUrl === null) blockedRefs.push(value.ref);
          else resolved.set(key, privateUrl);
          break;
        }
        const url = address?.platformUrl ?? null;
        if (url === null) {
          blockedRefs.push(value.ref);
        } else {
          // The platform URL answers for the port that owns 80/443. Any OTHER
          // public port of a multi-port service is reachable on its own number
          // and nowhere else, so the ref has to carry it — otherwise every
          // public port of one service would resolve to the same URL and quietly
          // point at whichever one happened to be lowest.
          const holder = standardPortsHolderFor(ports, target.public);
          resolved.set(key, port.port === holder ? url : `${url}:${port.port}`);
        }
        break;
      }
      default: {
        // Unknown output keys block rather than 400 so adding output keys later is
        // backward-compatible: the backend re-applies once the runtime learns them.
        blockedRefs.push(value.ref);
      }
    }
  }
  if (blockedRefs.length > 0) return { ok: false, blockedRefs };
  return { ok: true, env: Object.fromEntries(resolved) };
}
