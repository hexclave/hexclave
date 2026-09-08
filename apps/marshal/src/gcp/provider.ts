// The Google Cloud runtime: one tenant project per namespace, Cloud Run for serverless
// services, Compute Engine VMs with persistent disks for servers, Artifact Registry for
// images, Cloud Logging for logs, and per-tenant serverless NEGs behind one shared platform
// load balancer for custom domains. Opted into per namespace; see ../runtime.ts.
import { BUILDER_IMAGE, BUILD_DOCKERFILE_DIR, BUILD_ENV_DIR, BUILD_TIMEOUT_SECONDS, RAILPACK_CLI_SHA256, RAILPACK_CLI_URL, RAILPACK_FRONTEND_IMAGE, buildkitTmpfsSize, builderMachineFor, defaultMemoryMbFor, gcpConfig, getConfig, memorySizesFor } from "../config.js";
import { buildCompletionPath, buildHarnessScript, computeWebhookToken, generatedDockerfile, type Builder } from "../builds.js";
import { createDomainVerificationToken, domainVerificationRecord, hasDomainVerificationRecord } from "../domain-verification.js";
import { resolveEnv } from "../env-resolution.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { builderInstanceName, serviceName } from "../naming.js";
import { withPlatformDomainLease } from "../platform-domain-lock.js";
import type { AttachDomainResult, RuntimeProvider } from "../provider.js";
import { withReconciliationLease } from "../reconciliation-lock.js";
import { redactBuildLogLines } from "../redact-build-log.js";
import { assertServiceCanHoldADomain } from "../spec-helpers.js";
import { beginDomainClaimDeletion, claimDomain, createPendingDomainClaim, deletePendingDomainClaim, listDomainClaimsForService, listPendingDomainClaimsForService, presignValidatedUploadGet, readDomainClaim, readDomainClaimVersioned, readPendingDomainClaimVersioned, readSpec, releaseDomainClaim, rewriteDomainClaim } from "../store.js";
import { tenantContext } from "./context.js";
import { projectIdForNamespace } from "./projects.js";
import { applyRuntimeService, deleteRuntimeService, ensureDomainGateway, observeRuntimeService, runtimeAddress, runtimeLogs } from "./runtime.js";

// DNS propagation routinely takes longer than an interactive setup session. Pending claims are
// tenant-local and do not reserve the hostname globally, so keeping the same proof usable for a
// day improves retry UX without letting an unverified tenant block the real owner.
const PENDING_DOMAIN_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The hostname of a private server, or a stand-in when it has no running VM.
 *
 * The name-derived value is a stable PLACEHOLDER for the API's non-null field, not
 * something that resolves on GCP — connection refs deliberately never use it (see
 * resolveEnv, which blocks on a null address instead).
 */
function privateHostnamePlaceholder(envId: string, ns: string, key: string): string {
  return `${serviceName(envId, ns, key)}.internal`;
}

// ---------------------------------------------------------------------------
// Domains: a tenant-local pending claim proves DNS control before the global claim lands.

async function attachDomain(ns: string, hostname: string, serviceKey: string): Promise<AttachDomainResult> {
  return await withReconciliationLease(ns, serviceKey, async (lease) => {
    const stored = await readSpec(ns, serviceKey);
    if (stored === null) throw notFound(`service ${JSON.stringify(serviceKey)} not found in namespace ${JSON.stringify(ns)}`);
    assertServiceCanHoldADomain(serviceKey, stored.spec.config.ports, stored.spec.config.public, "Change the service's ports first, then attach the domain.");
    let existingClaim = await readDomainClaimVersioned(hostname);
    if (existingClaim === null) {
      let pending = await readPendingDomainClaimVersioned(ns, hostname);
      if (pending !== null && pending.value.expires_at_millis <= Date.now()) {
        await deletePendingDomainClaim(pending);
        pending = null;
      }
      if (pending === null) {
        const now = Date.now();
        await createPendingDomainClaim({
          hostname,
          ns,
          service_key: serviceKey,
          verification_token: createDomainVerificationToken(),
          created_at_millis: now,
          expires_at_millis: now + PENDING_DOMAIN_CLAIM_TTL_MS,
        });
        pending = await readPendingDomainClaimVersioned(ns, hostname);
        if (pending === null) throw new Error(`pending domain claim for ${hostname} disappeared immediately after creation`);
      }
      if (pending.value.service_key !== serviceKey) {
        throw conflict(`hostname ${JSON.stringify(hostname)} already has a pending attachment to another service in this namespace`);
      }

      const routingRecords = await withPlatformDomainLease(async (platformLease) => {
        await lease.assertOwned();
        await platformLease.assertOwned();
        return await (await tenantContext(ns)).domains.ensureFrontendDnsRecords(hostname);
      });
      const verificationRecord = domainVerificationRecord(hostname, pending.value.verification_token);
      if (!await hasDomainVerificationRecord(hostname, pending.value.verification_token)) {
        return { hostname, service_key: serviceKey, verified: false, dns_records: [verificationRecord, ...routingRecords] };
      }

      const claimed = await claimDomain({ hostname, ns, service_key: serviceKey, claimed_at_millis: Date.now() });
      if (!claimed) {
        existingClaim = await readDomainClaimVersioned(hostname);
        if (existingClaim === null || existingClaim.value.ns !== ns || existingClaim.value.service_key !== serviceKey) {
          throw conflict(`hostname ${JSON.stringify(hostname)} was verified and claimed elsewhere concurrently`);
        }
      }
      await deletePendingDomainClaim(pending);
    } else if (existingClaim.value.deleting_at_millis !== undefined) {
      throw conflict(`hostname ${JSON.stringify(hostname)} is still being detached; retry shortly`);
    } else if (existingClaim.value.ns !== ns) {
      throw conflict(`hostname ${JSON.stringify(hostname)} is already attached elsewhere`);
    } else if (existingClaim.value.service_key !== serviceKey) {
      // TODO(security): require renewed DNS proof for repoints, and design a proof-based
      // takeover flow for domains whose DNS ownership changed while an old A record and claim
      // remained. The initial tenant-bound proof prevents first-claim theft, but it is not yet
      // re-evaluated over the lifetime of an existing claim.
      const rewritten = await rewriteDomainClaim(existingClaim, { hostname, ns, service_key: serviceKey, claimed_at_millis: Date.now() });
      if (!rewritten) throw conflict(`hostname ${JSON.stringify(hostname)} changed owners concurrently; retry the attach`);
      await lease.assertOwned();
      await withPlatformDomainLease(async (platformLease) => {
        await lease.assertOwned();
        await platformLease.assertOwned();
        await (await tenantContext(ns)).domains.delete(hostname);
      });
    } else {
      await claimDomain(existingClaim.value);
    }

    const resolved = await resolveEnv(ns, stored.spec.env);
    if (!resolved.ok) throw badRequest(`service ${JSON.stringify(serviceKey)} is blocked on unresolved environment references`);
    const target = await ensureDomainGateway(stored, lease);
    await lease.assertOwned();
    const state = await withPlatformDomainLease(async (platformLease) => {
      await lease.assertOwned();
      await platformLease.assertOwned();
      return await (await tenantContext(ns)).domains.ensure(hostname, target);
    });
    return { hostname, service_key: serviceKey, verified: state.verified, dns_records: state.dnsRecords };
  });
}

async function readDomain(ns: string, hostname: string): Promise<AttachDomainResult> {
  const claim = await readDomainClaim(hostname);
  if (claim === null) {
    const pending = await readPendingDomainClaimVersioned(ns, hostname);
    if (pending === null) throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
    // Safe for polling: this can promote THIS tenancy's pending TXT proof, but it cannot
    // repoint an already claimed hostname.
    return await attachDomain(ns, hostname, pending.value.service_key);
  }
  if (claim.ns !== ns) throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
  const state = await (await tenantContext(ns)).domains.get(hostname);
  if (state === null) throw notFound(`hostname ${JSON.stringify(hostname)} has no load balancer on service ${JSON.stringify(claim.service_key)}`);
  return { hostname, service_key: claim.service_key, verified: state.verified, dns_records: state.dnsRecords };
}

async function detachDomain(ns: string, hostname: string, expectedServiceKey?: string): Promise<void> {
  const claim = await readDomainClaimVersioned(hostname);
  if (claim === null) {
    const pending = await readPendingDomainClaimVersioned(ns, hostname);
    if (pending === null || (expectedServiceKey !== undefined && pending.value.service_key !== expectedServiceKey)) {
      throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
    }
    // TODO(security): serialize pending deletion with the pending service's reconciliation
    // lease and make attachDomain revalidate the pending ETag immediately before claiming.
    // Without that, DELETE can report success while an already-in-flight verified PUT still
    // publishes the hostname. This is a revocation race, not an initial ownership bypass.
    await deletePendingDomainClaim(pending);
    return;
  }
  if (claim.value.ns !== ns) throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
  if (expectedServiceKey !== undefined && claim.value.service_key !== expectedServiceKey) {
    throw notFound(`hostname ${JSON.stringify(hostname)} is not attached to service ${JSON.stringify(expectedServiceKey)} in namespace ${JSON.stringify(ns)}`);
  }
  await withReconciliationLease(ns, claim.value.service_key, async (lease) => {
    const detached = await withPlatformDomainLease(async (platformLease) => {
      await lease.assertOwned();
      await platformLease.assertOwned();
      const current = await readDomainClaimVersioned(hostname);
      if (current === null
        || current.etag !== claim.etag
        || current.value.ns !== ns
        || current.value.service_key !== claim.value.service_key) return false;
      const deleting = await beginDomainClaimDeletion(current, Date.now());
      if (deleting === null) return false;
      await (await tenantContext(ns)).domains.delete(hostname);
      await lease.assertOwned();
      await platformLease.assertOwned();
      if (!await releaseDomainClaim(deleting)) throw conflict(`hostname ${JSON.stringify(hostname)} cleanup changed concurrently; retry the detach`);
      return true;
    });
    if (!detached) throw notFound(`hostname ${JSON.stringify(hostname)} changed owners while it was being detached`);
  });
}

// ---------------------------------------------------------------------------
// The builder

function createGcpBuilder(): Builder {
  return {
    name: "gcp",
    async startBuild(options, lease) {
      const config = getConfig();
      if (config.publicUrl === null) {
        throw new Error("MARSHAL_PUBLIC_URL must be set for real GCP builds — the builder VM calls the completion webhook on it");
      }
      const context = await tenantContext(options.ns);
      await lease.assertOwned();
      await context.artifactRegistry.ensureRepository();
      const tarballUrl = await presignValidatedUploadGet(options.ns, options.deploymentId, BUILD_TIMEOUT_SECONDS + 60);
      const webhookToken = computeWebhookToken(options.deploymentId, options.ns);
      const webhookUrl = `${config.publicUrl}${buildCompletionPath(options.deploymentId)}?ns=${encodeURIComponent(options.ns)}`;
      const targetsManifest = options.targets
        .map((target) => [target.serviceKey, target.pushTarget, target.dockerfilePath ?? "", target.rootDirectory ?? ""].join("\t"))
        .join("\n");
      const isRailpackBuild = options.targets.some((target) => target.dockerfilePath === null && target.baseImage === null);
      const files = [
        { path: "/marshal-build.sh", contentsBase64: Buffer.from(buildHarnessScript()).toString("base64") },
        { path: "/marshal-targets.tsv", contentsBase64: Buffer.from(`${targetsManifest}\n`, "utf8").toString("base64") },
        ...options.targets.flatMap((target) => Object.entries(target.buildEnv).flatMap(([key, value]) => value === "" ? [] : [{
          path: `${BUILD_ENV_DIR}/${target.serviceKey}/${key}`,
          contentsBase64: Buffer.from(value, "utf8").toString("base64"),
        }])),
        ...options.targets.flatMap((target) => {
          const generated = generatedDockerfile(target);
          return generated === null ? [] : [{
            path: `${BUILD_DOCKERFILE_DIR}/${target.serviceKey}/${generated.path}`,
            contentsBase64: Buffer.from(generated.contents, "utf8").toString("base64"),
          }];
        }),
      ];
      await lease.assertOwned();
      // What the caller asked for, floored at what this build shape needs. The
      // floor is not an entitlement: a Railpack build simply does not fit in the
      // smaller machine (see RAILPACK_MIN_BUILDER_MEMORY_MB), so a request below
      // it is raised rather than failed.
      const builder = builderMachineFor({ requestedMemoryMb: options.builderMemoryMb, isRailpackBuild });
      const machine = await context.compute.createBuilder({
        name: builderInstanceName(config.envId, options.deploymentId),
        image: BUILDER_IMAGE,
        machineType: builder.machineType,
        diskSizeGb: builder.diskSizeGb,
        files,
        env: {
          BUILD_ENV_DIR,
          BUILD_DOCKERFILE_DIR,
          TARBALL_URL: tarballUrl,
          REGISTRY_HOST: context.artifactRegistry.registryHost,
          WEBHOOK_URL: webhookUrl,
          WEBHOOK_TOKEN: webhookToken,
          BUILD_TIMEOUT_SECONDS: String(BUILD_TIMEOUT_SECONDS),
          RAILPACK_CLI_URL,
          RAILPACK_CLI_SHA256,
          RAILPACK_FRONTEND_IMAGE,
          // Scaled to the machine, not fixed: the snapshot store is what a big
          // dependency tree fills first, so a larger builder that kept a fixed
          // store would buy nothing at all.
          ...(isRailpackBuild ? { BUILDKIT_TMPFS_SIZE: buildkitTmpfsSize(builder.memoryMb) } : {}),
        },
      });
      return { builderApp: context.project.projectId, builderMachineId: machine.name };
    },
  };
}

function builderOutputIsTerminal(serialOutput: string): boolean {
  return /MARSHAL_BUILD_(?:DONE|FAILED|TIMEOUT)/.test(serialOutput);
}

/**
 * A builder whose startup script died before the harness ever started.
 *
 * This is terminal even though the VM is still RUNNING, and the distinction matters: the
 * harness arms the build watchdog itself and `shutdown -h now` is the last line of the very
 * script that failed, so nothing on the machine will ever post a webhook, print a
 * MARSHAL_BUILD_* marker, or power it off. Without this the liveness check sees a RUNNING
 * instance forever and the deployment stays "building" with no timeout that can rescue it.
 * Same signal `waitForServiceReady` already uses for service VMs.
 */
function builderStartupScriptFailed(serialOutput: string): boolean {
  return /Script "startup-script" failed/.test(serialOutput);
}

export { builderOutputIsTerminal, builderStartupScriptFailed };

// ---------------------------------------------------------------------------
// The provider

export function createGcpProvider(): RuntimeProvider {
  return {
    kind: "gcp",
    createBuilder: createGcpBuilder,
    memorySizesMb: (type) => memorySizesFor("gcp", type),
    defaultMemoryMb: (type) => defaultMemoryMbFor("gcp", type),

    async pushTarget(ns, serviceKey, deploymentId) {
      const context = await tenantContext(ns);
      return `${context.artifactRegistry.imageRepository(serviceName(getConfig().envId, ns, serviceKey))}:${deploymentId.toLowerCase()}`;
    },

    builtImageRef(deployment, serviceKey, digest) {
      const config = getConfig();
      const gcp = gcpConfig();
      // The registry host and project are Marshal's to know, and a harness that composed
      // them would have to be trusted about which project it pushed to.
      const tenantProjectId = deployment.builder_app
        ?? gcp.existingProjectIdForTests
        ?? projectIdForNamespace({ envId: config.envId, projectPrefix: gcp.projectPrefix }, deployment.ns);
      return `${gcp.region}-docker.pkg.dev/${tenantProjectId}/marshal/${serviceName(config.envId, deployment.ns, serviceKey)}@${digest}`;
    },

    applyService: applyRuntimeService,

    async observeService(stored) {
      const observation = await observeRuntimeService(stored);
      return {
        ...observation,
        // A private server is addressed by the VM's internal IP; a serverless service by its
        // single port-agnostic HTTPS endpoint, which no port number belongs on.
        privateHost: stored.spec.config.type === "server" ? observation.hostname : null,
      };
    },

    deleteService: deleteRuntimeService,

    async address(ns, key, stored) {
      const address = await runtimeAddress(ns, key, stored);
      return { ...address, privateHost: stored.spec.config.type === "server" ? address.hostname : null };
    },

    hostnamePlaceholder(ns, key) {
      return privateHostnamePlaceholder(getConfig().envId, ns, key);
    },

    staticPrivateHost() {
      // Nothing publishes a name-derived record on GCP: the address is the target's rollout.
      return null;
    },

    async serviceLogs(stored, sinceMillis, instance) {
      const lines = await runtimeLogs(stored, sinceMillis, instance);
      const lastAtMillis = lines.length === 0 ? null : lines[lines.length - 1].at_millis;
      return { lines, nextSinceMillis: lastAtMillis === null ? sinceMillis ?? Date.now() : lastAtMillis + 1 };
    },

    async builderLogsLive(deployment, sinceMillis, redactionValues) {
      if (deployment.builder_app === null || deployment.builder_machine_id === null) {
        return { lines: [], nextSinceMillis: sinceMillis ?? deployment.started_at_millis };
      }
      const output = await (await tenantContext(deployment.ns)).compute.getSerialOutput(deployment.builder_machine_id);
      const allLines = redactBuildLogLines(output, redactionValues).map((text, index) => ({
        at_millis: deployment.started_at_millis + index,
        stream: "stdout" as const,
        instance: null,
        text,
      }));
      const lines = allLines.filter((line) => sinceMillis === undefined || line.at_millis >= sinceMillis);
      const lastAtMillis = lines.length === 0 ? null : lines[lines.length - 1].at_millis;
      return { lines, nextSinceMillis: lastAtMillis === null ? sinceMillis ?? deployment.started_at_millis : lastAtMillis + 1 };
    },

    async builderLogsDrain(deployment, redactionValues) {
      if (deployment.builder_app === null || deployment.builder_machine_id === null) return [];
      const output = await (await tenantContext(deployment.ns)).compute.getSerialOutput(deployment.builder_machine_id);
      // Redact before splitting: a secret may itself contain newlines, in which case no
      // individual line contains the whole value and line-by-line redaction leaks every part.
      return redactBuildLogLines(output, redactionValues).map((text, index) => ({
        at_millis: deployment.started_at_millis + index,
        stream: "stdout" as const,
        instance: deployment.builder_machine_id,
        text,
      }));
    },

    async builderLiveness(deployment) {
      if (deployment.builder_app === null || deployment.builder_machine_id === null) return { alive: false, startupFailed: false, tail: "" };
      let machine;
      let serialOutput = "";
      try {
        const compute = (await tenantContext(deployment.ns)).compute;
        [machine, serialOutput] = await Promise.all([
          compute.getInstance(deployment.builder_machine_id),
          compute.getSerialOutput(deployment.builder_machine_id),
        ]);
      } catch (error) {
        // A transient provider error here must not turn a read into a 502 — leave the
        // deployment as-is until the next read.
        console.error(`stale-build liveness check for ${deployment.ns}/${deployment.id} failed`, error);
        return null;
      }
      // A VM can remain RUNNING briefly after its one-shot builder container exits. Terminal
      // harness markers take precedence over the VM lifecycle state so a lost webhook cannot
      // strand the deployment until the entire project is removed.
      const harnessIsTerminal = builderOutputIsTerminal(serialOutput) || builderStartupScriptFailed(serialOutput);
      const alive = !harnessIsTerminal && machine !== null && (machine.status === "RUNNING" || machine.status === "PROVISIONING" || machine.status === "STAGING");
      return {
        alive,
        startupFailed: builderStartupScriptFailed(serialOutput),
        tail: serialOutput.trim().split("\n").slice(-3).join(" | ").slice(0, 500),
      };
    },

    async deleteBuilder(deployment) {
      if (deployment.builder_machine_id === null) return;
      try {
        await (await tenantContext(deployment.ns)).compute.deleteInstance(deployment.builder_machine_id);
      } catch (error) {
        // The VM has automaticRestart disabled and its build process is already terminal. A
        // cleanup failure must not replace the recorded deployment result; project lifecycle
        // cleanup remains the final backstop for an orphan.
        console.error(`deleting builder VM for ${deployment.ns}/${deployment.id} failed`, error);
      }
    },

    buildRedactionValues() {
      // The builder's registry token is short-lived, minted on the VM from its metadata
      // server, and never enters this process.
      return [];
    },

    domains: {
      attach: attachDomain,
      read: readDomain,
      detach: detachDomain,
      async statesFor(ns, key) {
        const domainContext = await tenantContext(ns);
        const [claimedHostnames, pendingHostnames] = await Promise.all([
          listDomainClaimsForService(ns, key),
          listPendingDomainClaimsForService(ns, key),
        ]);
        const claimedDomains = await Promise.all(claimedHostnames.sort().map(async (hostname) => {
          const claim = await readDomainClaimVersioned(hostname);
          // Index entries are written before the global claim CAS, so an orphaned index entry
          // is possible and must be revalidated against the authenticated global authority.
          if (claim === null || claim.value.ns !== ns || claim.value.service_key !== key) return null;
          const domain = await domainContext.domains.get(hostname);
          return domain === null
            ? { hostname, verified: false, dns_records: [], error: "custom-domain infrastructure is missing" }
            : { hostname, verified: domain.verified, dns_records: domain.dnsRecords, error: null };
        }));
        const pendingDomains = await Promise.all(pendingHostnames.sort().map(async (hostname) => {
          const pending = await readPendingDomainClaimVersioned(ns, hostname);
          if (pending === null || pending.value.service_key !== key) return null;
          const routingRecords = await withPlatformDomainLease(async (platformLease) => {
            await platformLease.assertOwned();
            return await domainContext.domains.ensureFrontendDnsRecords(hostname);
          });
          return {
            hostname,
            verified: false,
            dns_records: [domainVerificationRecord(hostname, pending.value.verification_token), ...routingRecords],
            error: null,
          };
        }));
        return [...claimedDomains.filter((domain) => domain !== null), ...pendingDomains.filter((domain) => domain !== null)];
      },
      async releaseForService(ns, key, _stored, lease) {
        const domainContext = await tenantContext(ns);
        for (const hostname of await listDomainClaimsForService(ns, key)) {
          const claim = await readDomainClaimVersioned(hostname);
          if (claim !== null && claim.value.ns === ns && claim.value.service_key === key) {
            await withPlatformDomainLease(async (platformLease) => {
              await lease.assertOwned();
              await platformLease.assertOwned();
              const current = await readDomainClaimVersioned(hostname);
              if (current === null
                || current.etag !== claim.etag
                || current.value.ns !== ns
                || current.value.service_key !== key) return;
              const deleting = await beginDomainClaimDeletion(current, Date.now());
              if (deleting === null) return;
              await domainContext.domains.delete(hostname);
              await lease.assertOwned();
              await platformLease.assertOwned();
              if (!await releaseDomainClaim(deleting)) throw conflict(`domain ${JSON.stringify(hostname)} cleanup changed concurrently; retry service deletion`);
            });
          }
        }
        for (const hostname of await listPendingDomainClaimsForService(ns, key)) {
          const pending = await readPendingDomainClaimVersioned(ns, hostname);
          if (pending !== null && pending.value.service_key === key) await deletePendingDomainClaim(pending);
        }
      },
    },
  };
}
