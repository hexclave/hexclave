import { describe, expect, it } from "vitest";
import { soleHttpPort, specIsPublic, validateServiceSpec } from "../services.js";
import { machineConfigForSlot } from "./provider.js";
import { computeRevision } from "../revision.js";

function spec(config: Record<string, unknown> = {}) {
  return {
    config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "5432": { protocol: "http" } }, ...config },
    source: { image: "registry.fly.io/example@sha256:abc" },
    env: {},
  };
}

const machineFor = (config: Record<string, unknown>) => machineConfigForSlot({
  imageRef: "registry.fly.io/example@sha256:abc",
  spec: validateServiceSpec(spec(config)),
  revision: "revision",
  ns: "namespace",
  key: "service",
  slot: 0,
  env: {},
  volumeId: null,
});

describe("service ports", () => {
  it("preserves explicit HTTP ports and defaults a service to private", () => {
    expect(validateServiceSpec(spec()).config.ports).toEqual({ "5432": { protocol: "http" } });
    expect(specIsPublic(validateServiceSpec(spec()))).toBe(false);
    // Visibility is the SERVICE's, so it is read off the container and not
    // inferred from any port.
    expect(specIsPublic(validateServiceSpec(spec({ public: true, ports: { "3000": { protocol: "http" } } })))).toBe(true);
  });

  it("accepts a portless worker and gives it no Fly services entries", () => {
    expect(validateServiceSpec(spec({ ports: {} })).config.ports).toEqual({});
    expect(specIsPublic(validateServiceSpec(spec({ ports: {} })))).toBe(false);
    expect(machineFor({ ports: {} }).services).toEqual([]);
  });

  it("rejects port sets it could not serve", () => {
    expect(() => validateServiceSpec(spec({ ports: [] }))).toThrow(/must be an object keyed by port number/);
    expect(() => validateServiceSpec(spec({ ports: { "3000": {} } }))).toThrow(/protocol as "http" or "tcp"/);
    expect(() => validateServiceSpec(spec({ ports: { "0": { protocol: "http" } } }))).toThrow(/must be a port number between 1 and 65535/);
    expect(() => validateServiceSpec(spec({ ports: { web: {} } }))).toThrow(/must be a port number between 1 and 65535/);
    expect(() => validateServiceSpec(spec({ public: "yes" }))).toThrow(/config.public must be a boolean/);
    expect(() => validateServiceSpec(spec({ ports: { "3000": { protocol: "udp" } } }))).toThrow(/protocol as "http" or "tcp"/);
    // A duplicate port needs no rule of its own: an object cannot hold one key
    // twice, and the canonical-spelling rule below rules out the numeric aliases
    // that would otherwise sneak one port in under two keys.
    // Several ports on a public service are ACCEPTED: they are all reachable, so
    // there is no port the author did not ask to publish.
    expect(() => validateServiceSpec(spec({ public: true, ports: { "3000": { protocol: "http" }, "4000": { protocol: "http" } } })))
      .not.toThrow();
  });

  it("refuses a public service that the runtime could not serve", () => {
    // Raw TCP carries no SNI or Host, so a shared public address cannot tell
    // which service a connection belongs to — VERIFIED against real Fly, where
    // the edge accepts the connection and then drops it. A private service may
    // declare TCP freely; only public ingress is the problem.
    expect(() => validateServiceSpec(spec({ public: true, ports: { "5432": { protocol: "tcp" } } })))
      .toThrow(/may not declare a "tcp" port/);
    expect(() => validateServiceSpec(spec({ public: true, ports: { "3000": { protocol: "http" }, "5432": { protocol: "tcp" } } })))
      .toThrow(/may not declare a "tcp" port/);
    expect(() => validateServiceSpec(spec({ public: false, ports: { "5432": { protocol: "tcp" } } })))
      .not.toThrow();
    // A worker has nothing to serve on the addresses public ingress would
    // allocate. Unrepresentable when the flag lived on a port; refused now.
    expect(() => validateServiceSpec(spec({ public: true, ports: {} })))
      .toThrow(/must declare at least one port/);
  });

  it("gives 80/443 to the lowest public port, by number and not by key order", () => {
    // Determinism is the point: the holder is the port the service's bare URL
    // names and the only one a custom domain can front, so an arbitrary pick
    // would silently move both.
    const services = machineFor({ public: true, ports: { "8443": { protocol: "http" }, "443": { protocol: "http" } } }).services;
    const holder = services.find((service) => service.internal_port === 443);
    const other = services.find((service) => service.internal_port === 8443);
    expect(holder?.ports.map((entry) => entry.port).sort((a, b) => a - b)).toEqual([80, 443]);
    expect(other?.ports.map((entry) => entry.port)).toEqual([8443]);
  });

  it("refuses a port key that is not the port's canonical spelling", () => {
    // REGRESSION: "80" and "080" are different keys of one record but the same
    // port, so both survived and the machine declared two identical external
    // listeners — [80, 443, 80, 443]. The record shape only makes an EXACT key
    // impossible to repeat, which is what the old "duplicates are impossible by
    // construction" claim actually covered.
    expect(() => validateServiceSpec(spec({ public: true, ports: { "80": { protocol: "http" }, "080": { protocol: "http" } } })))
      .toThrow(/without a leading zero/);
    // Private ports had the same hole long before several public ports existed.
    expect(() => validateServiceSpec(spec({ ports: { "8080": { protocol: "http" }, "08080": { protocol: "http" } } })))
      .toThrow(/without a leading zero/);
    // A single non-canonical key is refused too — accepting it alone would just
    // move the collision to whichever later sync adds the canonical spelling.
    expect(() => validateServiceSpec(spec({ ports: { "080": { protocol: "http" } } }))).toThrow(/without a leading zero/);
    expect(() => validateServiceSpec(spec({ ports: { "0": { protocol: "http" } } }))).toThrow(/without a leading zero/);
  });

  it("never claims one external port from two of the service's ports", () => {
    // REGRESSION: externalPortsFor dedupes WITHIN one entry, but the holder also
    // claims 80 and 443, and `services` entries are listeners on the whole app.
    // A sibling numbered 80 or 443 therefore asked for a listener the holder had
    // already taken — `{80, 443}` produced external [80, 443, 443]. Every layer
    // passed it and Fly got a config it cannot serve.
    for (const config of [
      { public: true, ports: { "80": { protocol: "http" }, "443": { protocol: "http" } } },
      { public: true, ports: { "8": { protocol: "http" }, "80": { protocol: "http" } } },
      // Not only a public-service problem: the sole HTTP port of a PRIVATE
      // service is the holder too, so a raw TCP 443 beside it collided the same
      // way long before a service could be public with several ports.
      { public: false, ports: { "8080": { protocol: "http" }, "443": { protocol: "tcp" } } },
    ]) {
      expect(() => validateServiceSpec(spec(config)), JSON.stringify(config)).toThrow(/would collide with the standard bindings/);
    }
    // The port sets that DO reach a machine keep every external listener unique.
    for (const config of [
      { public: true, ports: { "3000": { protocol: "http" }, "8443": { protocol: "http" } } },
      { public: true, ports: { "80": { protocol: "http" }, "3000": { protocol: "http" } } },
      { public: true, ports: { "443": { protocol: "http" }, "3000": { protocol: "http" } } },
      { public: false, ports: { "8080": { protocol: "http" }, "9090": { protocol: "http" } } },
      { public: false, ports: { "8080": { protocol: "http" }, "5432": { protocol: "tcp" } } },
      { public: true, ports: { "80": { protocol: "http" } } },
    ]) {
      const services = machineFor(config).services;
      const external = services.flatMap((service) => service.ports.map((entry) => entry.port));
      expect(new Set(external).size, `${JSON.stringify(config)} -> ${JSON.stringify(external)}`).toBe(external.length);
    }
  });

  it("terminates TLS on a public service's own port numbers, but not on a private one's", () => {
    // VERIFIED AGAINST REAL FLY: a non-holder port of a public service is
    // reachable ONLY on its own number, so a plain `http` handler there
    // publishes it in cleartext while the URL we report for it says https. A
    // private service is the opposite case — its ports are reached over Flycast
    // as http://<host>:<port>, and TLS there would break every private url().
    const publicPorts = machineFor({ public: true, ports: { "3000": { protocol: "http" }, "8443": { protocol: "http" } } }).services;
    expect(publicPorts.find((service) => service.internal_port === 8443)?.ports)
      .toEqual([{ port: 8443, handlers: ["tls", "http"] }]);
    // The holder keeps plain 80 alongside TLS 443, and its own number is on a
    // public service too, so it terminates TLS as well.
    const holder = publicPorts.find((service) => service.internal_port === 3000)?.ports ?? [];
    expect(holder).toContainEqual({ port: 80, handlers: ["http"] });
    expect(holder).toContainEqual({ port: 443, handlers: ["tls", "http"] });
    expect(holder).toContainEqual({ port: 3000, handlers: ["tls", "http"] });

    const privatePorts = machineFor({ public: false, ports: { "8080": { protocol: "http" }, "9090": { protocol: "http" } } }).services;
    expect(privatePorts.find((service) => service.internal_port === 9090)?.ports)
      .toEqual([{ port: 9090, handlers: ["http"] }]);
  });

  it("never binds the same external port twice, even when the container listens on 80 or 443", () => {
    // The most common Docker default: a web image listening on 80, published.
    // Its own binding and the standard-port binding are the same number.
    const onPort80 = machineFor({ public: true, ports: { "80": { protocol: "http" } } });
    expect(onPort80.services[0].ports).toEqual([
      { port: 80, handlers: ["http"] },
      { port: 443, handlers: ["tls", "http"] },
    ]);
    // 443 is the dangerous one: its own plain-http binding must not shadow the
    // TLS-terminating one, or the platform URL would serve cleartext.
    const onPort443 = machineFor({ public: true, ports: { "443": { protocol: "http" } } });
    expect(onPort443.services[0].ports).toEqual([
      { port: 443, handlers: ["tls", "http"] },
      { port: 80, handlers: ["http"] },
    ]);
    for (const machine of [onPort80, onPort443]) {
      const bound = machine.services.flatMap((service) => service.ports.map((entry) => entry.port));
      expect(new Set(bound).size).toBe(bound.length);
    }
  });

  it("gives each port its own Fly service entry, and the public one 80/443 as well", () => {
    // A PRIVATE service's sole HTTP port still binds 80/443: attaching a custom
    // domain allocates public IPs and terminates TLS on 443, so without this its
    // verified domain would resolve and then refuse the connection.
    expect(machineFor({ ports: { "8080": { protocol: "http" } } })).toMatchObject({
      services: [{
        internal_port: 8080,
        ports: [
          { port: 8080, handlers: ["http"] },
          { port: 80, handlers: ["http"] },
          { port: 443, handlers: ["tls", "http"] },
        ],
        concurrency: { type: "requests" },
      }],
    });
    // A PUBLIC service's port: its own number — terminating TLS, because it is
    // reachable from the internet there — plus the standard ports so its fly.dev
    // URL and any custom domain certificate work.
    expect(machineFor({ public: true, ports: { "3000": { protocol: "http" } } })).toMatchObject({
      services: [{
        internal_port: 3000,
        ports: [
          { port: 3000, handlers: ["tls", "http"] },
          { port: 80, handlers: ["http"] },
          { port: 443, handlers: ["tls", "http"] },
        ],
      }],
    });
    // Raw TCP: no handlers, connection-based concurrency.
    expect(machineFor({ ports: { "5432": { protocol: "tcp" } } })).toMatchObject({
      services: [{
        internal_port: 5432,
        ports: [{ port: 5432 }],
        concurrency: { type: "connections" },
      }],
    });
  });

  it("emits one service entry per port for a multi-port service", () => {
    const machine = machineFor({
      type: "server",
      ports: { "3000": { protocol: "http" }, "5432": { protocol: "tcp" }, "9090": { protocol: "http" } },
    });
    const services = machine.services;
    expect(services).toHaveLength(3);
    expect(services.map((service) => service.internal_port)).toEqual([3000, 5432, 9090]);
    // With two HTTP ports there is no single obvious holder, so NOTHING binds
    // the standard ports — which is also why a custom domain is refused here.
    expect(services.filter((service) => service.ports.some((entry) => entry.port === 443))).toHaveLength(0);
  });

  it("names a port for internal_url only when it is unambiguous", () => {
    expect(soleHttpPort(validateServiceSpec(spec({ ports: { "8080": { protocol: "http" } } })).config.ports)).toBe(8080);
    // A TCP sibling does not make the single HTTP port ambiguous.
    expect(soleHttpPort(validateServiceSpec(spec({
      type: "server", ports: { "8080": { protocol: "http" }, "5432": { protocol: "tcp" } },
    })).config.ports)).toBe(8080);
    // Two HTTP ports leave no way to pick one.
    expect(soleHttpPort(validateServiceSpec(spec({ ports: { "8080": { protocol: "http" }, "9090": { protocol: "http" } } })).config.ports)).toBe(null);
    expect(soleHttpPort(validateServiceSpec(spec({ ports: { "5432": { protocol: "tcp" } } })).config.ports)).toBe(null);
  });

  it("rolls the revision when any part of the port set changes", () => {
    const key = Buffer.alloc(32, 7);
    const revisionOf = (config: Record<string, unknown>) => computeRevision(validateServiceSpec(spec(config)), key);
    const base = revisionOf({ ports: { "5432": { protocol: "http" } } });
    // Each of these changes the machine's Fly services array or its ingress, so
    // none of them may hash identically to the base.
    expect(revisionOf({ ports: { "5432": { protocol: "tcp" } } })).not.toBe(base);
    expect(revisionOf({ public: true, ports: { "5432": { protocol: "http" } } })).not.toBe(base);
    expect(revisionOf({ ports: { "6000": { protocol: "http" } } })).not.toBe(base);
    expect(revisionOf({ ports: { "5432": { protocol: "http" }, "9090": { protocol: "http" } } })).not.toBe(base);
    // Same set, restated with its defaults spelled out: identical machines, so
    // the revision must NOT roll (it would restart the fleet for nothing).
    expect(revisionOf({ public: false, ports: { "5432": { protocol: "http" } } })).toBe(base);
    // Nor may merely REORDERING the list roll it — same machines, and for a
    // volume-backed server a needless roll is real downtime.
    expect(revisionOf({ ports: { "9090": { protocol: "http" }, "5432": { protocol: "http" } } }))
      .toBe(revisionOf({ ports: { "5432": { protocol: "http" }, "9090": { protocol: "http" } } }));
  });
});

describe("start command", () => {
  const key = Buffer.alloc(32, 7);

  it("replaces the image's entrypoint AND command, not just its command", () => {
    // VERIFIED against real Fly: with `init.exec` set, an nginx image's
    // /docker-entrypoint.sh never runs. `init.cmd` alone is passed TO that
    // entrypoint as arguments instead, which would silently mean something else
    // for every image that has one.
    expect(machineFor({ start_command: "node server.js" }).init).toEqual({ exec: ["/bin/sh", "-c", "node server.js"] });
    // Absent when there is none, so a spec without one is byte-identical to what
    // it was before this field existed and no machine rolls for it.
    expect(machineFor({}).init).toBeUndefined();
  });

  it("rolls the revision, or the change would be silently dropped", () => {
    // The start command produces no new image, so if it hashed identically
    // applyServiceSpec would take the unchanged path and keep the previous spec
    // — the same trap persistent volumes have.
    const revisionOf = (config: Record<string, unknown>) => computeRevision(validateServiceSpec(spec(config)), key);
    const base = revisionOf({});
    expect(revisionOf({ start_command: "node server.js" })).not.toBe(base);
    expect(revisionOf({ start_command: "node other.js" })).not.toBe(revisionOf({ start_command: "node server.js" }));
    expect(revisionOf({ start_command: "node server.js" })).toBe(revisionOf({ start_command: "node server.js" }));
  });

  it("refuses a command that could not survive an argv entry", () => {
    for (const invalid of ["a\nb", "", "  ", "x".repeat(2049), 42]) {
      expect(() => validateServiceSpec(spec({ start_command: invalid })), String(invalid)).toThrow(/start_command/);
    }
  });
});
