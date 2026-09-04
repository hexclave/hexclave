import { createHmac } from "node:crypto";
import { getConfig } from "./config.js";
import { serviceRevisionKey } from "./spec-crypto.js";
import { portEntries, type ServiceSpec } from "./types.js";

// The revision identifies a desired state: config + source + env, canonically serialized.
// Region/machine size are runtime policy and deliberately excluded, so a policy change
// never triggers a rebuild/redeploy on its own. Env is hashed in its ORIGINAL EnvValue
// form ({ref} unresolved) — a ref whose target output changes does not change the
// revision; the backend re-applies and the runtime converges under the same revision.
export function computeRevision(spec: ServiceSpec, rootKey: Buffer = getConfig().dataEncryptionRootKey): string {
  const canonical = {
    config: {
      // The type decides the machine's autostop policy (suspend vs stop), so a type-only
      // change has to roll the runtime rather than hash identically.
      type: spec.config.type,
      min_instances: spec.config.min_instances,
      max_instances: spec.config.max_instances,
      // Ingress: flipping it rolls every machine, since it changes both the
      // handlers on each port and the addresses the app holds.
      public: spec.config.public,
      // Normalized rather than taken verbatim: the ports decide the machine's
      // provider networking config, so any change to one must roll the runtime. Field
      // order is fixed here so two equivalent specs that merely serialized their
      // keys differently still hash the same, and the list is sorted by port
      // NUMBER — object key order would put "80" after "8080", which would make
      // the revision depend on how the ports happened to be written and restart
      // the fleet for nothing (which for a volume-backed "server" means real
      // downtime).
      ports: portEntries(spec.config.ports)
        .map((entry) => ({ port: entry.port, protocol: entry.protocol })),
      // It MUST be included: without it a volume-only change —
      // adding, resizing, removing, or RE-IDENTIFYING a disk — produces the same revision, so
      // applyServiceSpec takes the unchanged path, keeps the PREVIOUS spec, and silently drops
      // the change. The id is part of it because it contributes to the disk identity: changing it means
      // mounting a different disk.
      ...(spec.config.persistent_volumes !== undefined ? { persistent_volumes: spec.config.persistent_volumes } : {}),
      // It MUST be included, for the same reason as the volumes above: it is
      // machine configuration rather than image content, so a spec that only
      // changes the start command produces no new image — and if it hashed
      // identically, applyServiceSpec would take the unchanged path, keep the
      // previous spec, and silently drop it. Conditional so a spec without one
      // hashes exactly as it did before this field existed.
      ...(spec.config.start_command !== undefined ? { start_command: spec.config.start_command } : {}),
    },
    source: spec.source,
    env: Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  // A plain digest turns the stored revision into an offline oracle for low-entropy secret
  // values when the rest of the spec is known. The purpose-derived HMAC key keeps revisions
  // deterministic for reconciliation without disclosing such a verifier in the bucket or DB.
  return createHmac("sha256", serviceRevisionKey(rootKey)).update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}
