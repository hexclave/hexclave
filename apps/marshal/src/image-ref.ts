// Parsing for the image references a deployment target may name.
//
// KEPT IN SYNC WITH parseDeploymentImageRef in packages/shared/src/deployments.ts,
// which is what the CLI and the backend validate against. Marshal keeps its own
// copy for the same reason it keeps its own port and volume rules: it is the
// last line before the runtime, it must be AT LEAST as strict as the layers
// above it, and it takes no dependency on the product's packages.
//
// The rules that matter here: a reference is fully qualified before it is used
// (the runtime config must name one unambiguous registry), and it carries an explicit tag or digest (an implicit ":latest"
// is the one reference guaranteed to move under a running service).
//
// Nothing here contacts a registry. A tag stays a tag all the way into the
// runtime config and the provider resolves it when it pulls; see startSourceDeployment
// for what that means for a caller.

import { badRequest } from "./errors.js";

export const MAX_IMAGE_REF_LENGTH = 512;
export const DEFAULT_REGISTRY = "docker.io";
export const DEFAULT_REGISTRY_NAMESPACE = "library";
// Other names for Docker Hub; references use them interchangeably.
const DOCKER_HUB_REGISTRY_ALIASES = new Set(["index.docker.io", "registry-1.docker.io"]);

const PATH_COMPONENT_REGEX = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const TAG_REGEX = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_HOST_REGEX = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?$/;

/** Exactly one of `tag` and `digest` is set. */
export type ImageRef = {
  registry: string,
  repository: string,
  tag: string | null,
  digest: string | null,
  canonical: string,
};

/** Whether a string is a well-formed sha256 digest. */
export function isImageDigest(value: string): boolean {
  return DIGEST_REGEX.test(value);
}

/**
 * The same reference with `digest` in place of whatever version it named.
 *
 * Composed from the author's reference rather than a provider-internal mirror name, so the
 * recorded image remains recognizable in deployment history.
 */
export function pinToDigest(imageRef: string, digest: string): string {
  const atIndex = imageRef.indexOf("@");
  const beforeDigest = atIndex === -1 ? imageRef : imageRef.slice(0, atIndex);
  // Same tag-separator rule as validateImageRef: a ":" is a tag only after the
  // last "/", before which it is the registry host's port.
  const lastSlashIndex = beforeDigest.lastIndexOf("/");
  const colonIndex = beforeDigest.indexOf(":", lastSlashIndex + 1);
  const name = colonIndex === -1 ? beforeDigest : beforeDigest.slice(0, colonIndex);
  return `${name}@${digest}`;
}

/**
 * Parses a fully-normalized image reference, or throws a 400 naming the rule
 * that was broken. `label` names the field so the caller's context survives into
 * the message.
 */
export function validateImageRef(value: unknown, label: string): ImageRef {
  if (typeof value !== "string" || value === "") throw badRequest(`${label} must be a non-empty string`);
  if (value.length > MAX_IMAGE_REF_LENGTH) throw badRequest(`${label} must be at most ${MAX_IMAGE_REF_LENGTH} characters`);
  // Control characters and whitespace would both break the machine config this
  // ends up in, and neither can appear in a valid reference.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(value)) throw badRequest(`${label} must not contain whitespace or control characters`);
  if (value.includes("://")) throw badRequest(`${label} must not have a scheme`);

  const atIndex = value.indexOf("@");
  const digest = atIndex === -1 ? null : value.slice(atIndex + 1);
  const beforeDigest = atIndex === -1 ? value : value.slice(0, atIndex);
  if (digest !== null && !isImageDigest(digest)) {
    throw badRequest(`${label} has an invalid digest (expected "sha256:" followed by 64 lowercase hex characters)`);
  }

  // A ":" is a tag separator only after the last "/" — before it, it is a
  // registry host's port.
  const lastSlashIndex = beforeDigest.lastIndexOf("/");
  const colonIndex = beforeDigest.indexOf(":", lastSlashIndex + 1);
  const tag = colonIndex === -1 ? null : beforeDigest.slice(colonIndex + 1);
  const name = colonIndex === -1 ? beforeDigest : beforeDigest.slice(0, colonIndex);
  if (tag !== null && !TAG_REGEX.test(tag)) throw badRequest(`${label} has an invalid tag`);
  if (tag !== null && digest !== null) throw badRequest(`${label} must name a tag or a digest, not both`);
  if (tag === null && digest === null) throw badRequest(`${label} must name an explicit tag or digest (an untagged image means ":latest", which can change between deploys)`);

  const components = name.split("/");
  if (components.some((component) => component === "")) throw badRequest(`${label} has an empty path segment`);
  // Lowercased: DNS is case-insensitive, so `DOCKER.IO` is a legal spelling of
  // the hub, and an uppercase one matched neither the alias set nor the
  // `library/` rule nor the registry-host swap.
  const first = components[0].toLowerCase();
  const hasRegistry = components.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  // Docker Hub answers to several names; they are one registry, so they normalize to one.
  const registry = hasRegistry
    ? (DOCKER_HUB_REGISTRY_ALIASES.has(first) ? DEFAULT_REGISTRY : first)
    : DEFAULT_REGISTRY;
  const repositoryComponents = hasRegistry ? components.slice(1) : components;
  if (hasRegistry && !REGISTRY_HOST_REGEX.test(registry)) throw badRequest(`${label} has an invalid registry host`);
  // Range-checked rather than spelled out in the regex, which would be unreadable.
  const registryPort = hasRegistry ? /:(\d+)$/.exec(registry) : null;
  if (registryPort !== null && (Number(registryPort[1]) < 1 || Number(registryPort[1]) > 65535)) {
    throw badRequest(`${label} has an invalid registry port ${registryPort[1]} (must be between 1 and 65535)`);
  }
  if (repositoryComponents.length === 0) throw badRequest(`${label} names a registry but no repository`);
  for (const component of repositoryComponents) {
    if (!PATH_COMPONENT_REGEX.test(component)) throw badRequest(`${label} has an invalid repository path segment ${JSON.stringify(component)}`);
  }
  // Keyed on the RESOLVED registry, not on whether one was written: Docker applies
  // the `library/` default whenever the registry is Docker Hub however it was
  // spelled, so `docker.io/postgres` is `library/postgres` too.
  const repository = registry === DEFAULT_REGISTRY && repositoryComponents.length === 1
    ? `${DEFAULT_REGISTRY_NAMESPACE}/${repositoryComponents[0]}`
    : repositoryComponents.join("/");

  return {
    registry,
    repository,
    tag,
    digest,
    canonical: `${registry}/${repository}${digest === null ? `:${tag}` : `@${digest}`}`,
  };
}
