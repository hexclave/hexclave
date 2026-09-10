import { globalPrismaClient } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { Prisma } from "@/generated/prisma/client";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";

export const AUDIT_LOG_ACTIONS = [
  "impersonation.started",
  "impersonation.revoked",
  "project_settings.updated",
  "user.created",
  "user.deleted",
  "user.updated",
  "user.restricted",
  "user.unrestricted",
  "user.password.set",
  "user.mfa.enabled",
  "user.mfa.removed",
  "user.password_reset.sent",
  "user.sign_in_invitation.sent",
  "contact_channel.created",
  "contact_channel.updated",
  "contact_channel.deleted",
  "contact_channel.verification.sent",
  "project_api_key.created",
  "project_api_key.updated",
  "project_api_key.revoked",
  "config_source.unlinked",
  "team.created",
  "team.updated",
  "team.deleted",
  "team_membership.created",
  "team_membership.deleted",
  "team_permission.granted",
  "team_permission.revoked",
  "permission_definition.created",
  "permission_definition.updated",
  "permission_definition.deleted",
  "project_permission.granted",
  "project_permission.revoked",
  "payment.checkout.created",
  "payment.item_quantity.changed",
  "payment.refund.created",
  "payment.stripe.setup_started",
  "payment.method_config.updated",
  "email.template.created",
  "email.template.updated",
  "email.template.deleted",
  "email.theme.created",
  "email.theme.updated",
  "email.theme.deleted",
  "email.draft.created",
  "email.draft.updated",
  "email.draft.deleted",
  "email.managed_domain.setup_started",
  "email.managed_domain.applied",
  "email.managed_domain.deleted",
] as const;

export type AuditLogAction = typeof AUDIT_LOG_ACTIONS[number];

export const AUDIT_LOG_ACTOR_TYPES = [
  "admin_user",
  "server_key",
  "unknown",
] as const;

export type AuditLogActorType = typeof AUDIT_LOG_ACTOR_TYPES[number];

export type AuditLogActor = {
  type: AuditLogActorType,
  userId: string | null,
  label: string,
};

// Legacy sentinel written before the targetUserId column was nullable.
// New rows store SQL NULL. The list API still maps this sentinel to null so
// historical project-scoped events render correctly.
export const AUDIT_LOG_NO_TARGET_USER_ID = "00000000-0000-0000-0000-000000000000";

// Intentionally narrower than SmartRequestAuth: route handlers only declare the
// auth fields they need in yup schemas, so callers pass a partial auth object.
export type AuditActorSource = {
  type: "client" | "server" | "admin",
  adminUser?: {
    id: string,
    display_name: string | null,
    primary_email: string | null,
  } | null | undefined,
  /**
   * Set by createCrudHandlers' programmatic admin/server/client helpers
   * (adminUpdate, serverCreate, etc.). Those synthesize auth.type from the
   * helper name (often "admin") even for signup / self-service /
   * password-reset internals — never treat them as dashboard/admin audit
   * actors. HTTP route handlers leave this unset.
   */
  isProgrammaticInvocation?: boolean,
};

/**
 * Whether this auth should produce a Compliance admin-audit event.
 *
 * Dashboard-only: requires a resolved admin user from
 * `x-stack-admin-access-token`. Bare admin/server API keys, client
 * self-service, and programmatic CRUD helpers (`isProgrammaticInvocation`)
 * do not audit.
 *
 * Prefer calling `recordAuditEvent` and letting it no-op; use this helper
 * only to skip expensive metadata construction when nothing will be written.
 */
export function shouldRecordAdminAudit(auth: AuditActorSource): boolean {
  return shouldRecordDashboardAudit(auth);
}

/**
 * Same gate as {@link shouldRecordAdminAudit}. Kept as a named alias for call
 * sites that want to emphasize the dashboard-actor requirement.
 */
export function shouldRecordDashboardAudit(auth: AuditActorSource): boolean {
  if (auth.isProgrammaticInvocation === true) {
    return false;
  }
  // adminUser is only set when the request carried a valid dashboard admin
  // access token — not when authenticating with an API key alone.
  return auth.adminUser != null;
}

const MAX_CHANGED_PATHS = 100;
const MAX_AUDIT_VALUE_STRING_LENGTH = 500;

// Leaf path segments that typically hold secrets. Parent namespaces like
// `auth.password.allowSignIn` are fine — only the leaf is checked.
const SENSITIVE_LEAF_SEGMENTS = new Set([
  "password",
  "password_hash",
  "totp_secret_base64",
  "totpsecretbase64",
  "clientsecret",
  "client_secret",
  "secret",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "appleprivatekey",
  "apple_private_key",
  "connectionstring",
  "connection_string",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "webhooksecret",
  "webhook_secret",
  "authorization",
  "credentials",
  "credential",
]);

// Compact (no `_`/`-`) substrings that mean the leaf holds a secret even when
// the key is not an exact match (`my_api_key`, `totp_secret_base64`).
const SENSITIVE_LEAF_SUBSTRINGS = [
  "password",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "connectionstring",
  "authorization",
] as const;

export type AuditFieldChange = {
  before: Prisma.JsonValue,
  after: Prisma.JsonValue,
};

/**
 * True when the path's leaf (or known secret-bearing prefixes) should never
 * have values persisted — path keys are still recorded in changed_paths.
 *
 * Boolean `has_*` flags and `*_id` identifiers are kept: they name a secret
 * without being one (`has_secret_server_key`, `refresh_token_id`).
 */
export function isAuditLogPathSensitive(path: string): boolean {
  const normalized = path.toLowerCase();
  if (
    normalized.includes("dbsync.externaldatabases")
    || normalized.includes("sourceoftruth.connectionstring")
  ) {
    return true;
  }
  const segments = normalized.split(".");
  const leaf = segments[segments.length - 1] ?? "";
  if (leaf.startsWith("has_") || leaf.endsWith("_id") || leaf === "id") {
    return false;
  }
  const compactLeaf = leaf.replace(/[_-]/g, "");
  if (SENSITIVE_LEAF_SEGMENTS.has(leaf) || SENSITIVE_LEAF_SEGMENTS.has(compactLeaf)) {
    return true;
  }
  return SENSITIVE_LEAF_SUBSTRINGS.some((token) => compactLeaf.includes(token));
}

/**
 * Last-line sanitizer so a caller cannot persist a secret by stuffing it into
 * `metadata`. Sensitive leaves are dropped; `changed_paths` keeps the path
 * names (those strings are keys, not values).
 */
export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeAuditJsonValue(metadata, "");
  if (sanitized == null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as Record<string, unknown>;
}

function sanitizeAuditJsonValue(value: unknown, path: string): unknown {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    // Path names in `changed_paths` are not secret values.
    if (path === "changed_paths" || path.endsWith(".changed_paths")) {
      return value;
    }
    return value.map((item, index) => sanitizeAuditJsonValue(item, path === "" ? String(index) : `${path}.${index}`));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (isAuditLogPathSensitive(key) || isAuditLogPathSensitive(childPath)) {
        continue;
      }
      const sanitizedChild = sanitizeAuditJsonValue(child, childPath);
      if (sanitizedChild !== undefined) {
        result[key] = sanitizedChild;
      }
    }
    return result;
  }
  return value;
}

export function resolveAuditActor(auth: AuditActorSource): AuditLogActor {
  if (auth.adminUser != null) {
    const label = auth.adminUser.display_name?.trim()
      || auth.adminUser.primary_email?.trim()
      || auth.adminUser.id;
    return {
      type: "admin_user",
      userId: auth.adminUser.id,
      label,
    };
  }
  if (auth.type === "server") {
    return {
      type: "server_key",
      userId: null,
      label: "Server API key",
    };
  }
  if (auth.type === "admin") {
    return {
      type: "unknown",
      userId: null,
      label: "Admin API key",
    };
  }
  return {
    type: "unknown",
    userId: null,
    label: "Unknown",
  };
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Collect leaf config/update paths for audit metadata.
 * Supports both dotted path-notation objects and nested objects.
 */
export function collectConfigPaths(value: unknown, prefix = ""): string[] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return prefix === "" ? [] : [prefix];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix === "" ? [] : [prefix];
  }
  const paths: string[] = [];
  for (const [key, child] of entries) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (child != null && typeof child === "object" && !Array.isArray(child)) {
      const nested = collectConfigPaths(child, path);
      if (nested.length === 0) {
        paths.push(path);
      } else {
        paths.push(...nested);
      }
    } else {
      paths.push(path);
    }
  }
  return paths;
}

export function limitChangedPaths(paths: string[]): { changed_paths: string[], changed_paths_truncated: boolean } {
  if (paths.length <= MAX_CHANGED_PATHS) {
    return { changed_paths: paths, changed_paths_truncated: false };
  }
  return {
    changed_paths: paths.slice(0, MAX_CHANGED_PATHS),
    changed_paths_truncated: true,
  };
}

/**
 * Resolve a dotted path against nested objects and/or path-notation keys
 * (e.g. `{ "auth.password.allowSignIn": true }` or `{ "emails.server": { host: "…" } }`).
 */
export function getValueAtDottedPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  if (root == null || typeof root !== "object" || Array.isArray(root)) {
    return undefined;
  }
  const record = root as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, path)) {
    return record[path];
  }
  const segments = path.split(".");
  // Prefer longest matching path-notation key prefix (emails.server before emails).
  for (let end = segments.length - 1; end >= 1; end--) {
    const head = segments.slice(0, end).join(".");
    if (Object.prototype.hasOwnProperty.call(record, head)) {
      return getValueAtDottedPath(record[head], segments.slice(end).join("."));
    }
  }
  const first = segments[0] ?? throwErr(`Unexpected empty path segment while resolving audit log path ${JSON.stringify(path)}`);
  if (!Object.prototype.hasOwnProperty.call(record, first)) {
    return undefined;
  }
  return getValueAtDottedPath(record[first], segments.slice(1).join("."));
}

function looksLikeSecretString(value: string): boolean {
  // Connection strings / URLs with embedded credentials.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s]*@/i.test(value)) {
    return true;
  }
  return false;
}

function normalizeAuditJsonValue(value: unknown): Prisma.JsonValue | undefined {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (looksLikeSecretString(value)) {
      return undefined;
    }
    if (value.length > MAX_AUDIT_VALUE_STRING_LENGTH) {
      return `${value.slice(0, MAX_AUDIT_VALUE_STRING_LENGTH)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items: Prisma.JsonValue[] = [];
    for (const item of value) {
      if (item === null || typeof item === "boolean" || typeof item === "number") {
        items.push(item);
        continue;
      }
      if (typeof item === "string") {
        if (looksLikeSecretString(item)) {
          return undefined;
        }
        items.push(
          item.length > MAX_AUDIT_VALUE_STRING_LENGTH
            ? `${item.slice(0, MAX_AUDIT_VALUE_STRING_LENGTH)}…`
            : item,
        );
        continue;
      }
      // Nested objects/arrays in a leaf value — too unstructured to log safely.
      return undefined;
    }
    return items;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isBlankAuditValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function auditValuesEqual(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (isBlankAuditValue(before) && isBlankAuditValue(after)) return true;
  try {
    return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
  } catch {
    return false;
  }
}

/**
 * Compact label for a removed config object (e.g. oauth provider set to null).
 * Prefer the provider `type` field when present.
 */
function summarizeConfigObjectForAudit(value: Record<string, unknown>): string {
  if (typeof value.type === "string" && value.type.trim() !== "") {
    return value.type;
  }
  if (value.isShared === true) return "shared";
  if (value.allowSignIn === true) return "enabled";
  return "configured";
}

function oauthProviderParentPath(path: string): string | null {
  const match = /^auth\.oauth\.providers\.([^.]+)/.exec(path);
  if (match == null) return null;
  return `auth.oauth.providers.${match[1]}`;
}

/**
 * Expand object-valued patch paths into leaf diffs and drop empty no-ops.
 *
 * OAuth provider enable/disable stay as one path each (summary string), so the
 * UI can show `linkedin → Added` / `google → Removed` instead of dumping every
 * shared-schema leaf (clientId, facebookConfigId, …).
 */
export function expandConfigChangePaths(options: {
  paths: string[],
  beforeRoot: unknown,
  afterRoot: unknown,
}): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    expanded.push(path);
  };

  // collectConfigPaths already leaf-expands provider objects — collapse whole
  // provider creates/deletes back to the parent path for a concise audit row.
  const oauthSummaryParents = new Set<string>();
  for (const path of options.paths) {
    const parent = oauthProviderParentPath(path);
    if (parent == null) continue;
    const before = getValueAtDottedPath(options.beforeRoot, parent);
    const after = getValueAtDottedPath(options.afterRoot, parent);
    if (after === null && isPlainObject(before)) {
      oauthSummaryParents.add(parent);
      continue;
    }
    if (isPlainObject(after) && isBlankAuditValue(before)) {
      oauthSummaryParents.add(parent);
    }
  }
  for (const parent of oauthSummaryParents) {
    push(parent);
  }

  for (const path of options.paths) {
    const parent = oauthProviderParentPath(path);
    if (parent != null && oauthSummaryParents.has(parent)) {
      continue;
    }

    const before = getValueAtDottedPath(options.beforeRoot, path);
    const after = getValueAtDottedPath(options.afterRoot, path);

    if (isPlainObject(after)) {
      for (const leaf of collectConfigPaths(after, path)) {
        const leafBefore = getValueAtDottedPath(options.beforeRoot, leaf);
        const leafAfter = getValueAtDottedPath(options.afterRoot, leaf);
        if (isBlankAuditValue(leafAfter) && isBlankAuditValue(leafBefore)) continue;
        if (auditValuesEqual(leafBefore, leafAfter)) continue;
        push(leaf);
      }
      continue;
    }

    // Whole-object delete: keep one path; value builder summarizes the before object.
    if (after === null && isPlainObject(before)) {
      push(path);
      continue;
    }

    if (isBlankAuditValue(before) && isBlankAuditValue(after)) {
      continue;
    }
    // collectConfigPaths already emits leaves for object patches — skip no-op
    // leaves (e.g. allowSignIn true→true when only switching shared→standard keys).
    if (auditValuesEqual(before, after)) {
      continue;
    }
    push(path);
  }
  return expanded;
}

/**
 * Build before/after value map for non-sensitive paths only.
 * Sensitive paths stay in changed_paths but are omitted here.
 */
export function buildNonSensitiveFieldChanges(options: {
  paths: string[],
  beforeRoot: unknown,
  afterRoot: unknown,
}): Record<string, AuditFieldChange> {
  const changes: Record<string, AuditFieldChange> = {};
  for (const path of options.paths) {
    if (isAuditLogPathSensitive(path)) {
      continue;
    }
    const beforeRaw = getValueAtDottedPath(options.beforeRoot, path);
    const afterRaw = getValueAtDottedPath(options.afterRoot, path);

    // Whole oauth provider (or other config object) removed/added. Plain objects
    // are otherwise non-auditable; summarize so the UI can show
    // "google → Removed" / "— → linkedin".
    if (afterRaw === null && isPlainObject(beforeRaw)) {
      changes[path] = {
        before: summarizeConfigObjectForAudit(beforeRaw),
        after: null,
      };
      continue;
    }
    if (isPlainObject(afterRaw) && isBlankAuditValue(beforeRaw)) {
      changes[path] = {
        before: null,
        after: summarizeConfigObjectForAudit(afterRaw),
      };
      continue;
    }

    const beforeNormalized = normalizeAuditJsonValue(beforeRaw);
    const afterNormalized = normalizeAuditJsonValue(afterRaw);
    // If either side looks secret / non-auditable, skip values for this path.
    if (beforeNormalized === undefined || afterNormalized === undefined) {
      continue;
    }
    if (auditValuesEqual(beforeNormalized, afterNormalized)) {
      continue;
    }
    changes[path] = {
      before: beforeNormalized,
      after: afterNormalized,
    };
  }
  return changes;
}

/**
 * Admin audit write — the single integration point for new call sites.
 *
 * Hard-gates dashboard-only at this hook: without a resolved `adminUser`,
 * this is a no-op (bare API keys / programmatic CRUD never write). Call sites
 * do not need their own auth-type checks for correctness; optional
 * `shouldRecordAdminAudit` / `shouldRecordDashboardAudit` early-returns are
 * only for skipping metadata work.
 *
 * Pass `auth` (not a pre-built actor); actor resolution is handled here.
 * Insert failures are reported, not thrown — a missing audit row must never
 * fail the audited action or the HTTP request. Viewing is gated by the
 * Compliance app; writes are not.
 *
 * For settings diffs, use `buildProjectSettingsAuditMetadata` then pass the
 * result as `metadata` — don't invent per-action wrappers for simple events.
 */
export async function recordAuditEvent(options: {
  tenancy: Tenancy,
  auth: AuditActorSource,
  action: AuditLogAction,
  targetUserId?: string | null,
  reason?: string | null,
  metadata?: Record<string, unknown> | null,
}): Promise<void> {
  // Central dashboard-only gate — do not weaken this in individual routes.
  if (!shouldRecordDashboardAudit(options.auth)) {
    return;
  }

  const actor = resolveAuditActor(options.auth);
  const reason = normalizeReason(options.reason);

  try {
    await globalPrismaClient.auditLogEvent.create({
      data: {
        tenancyId: options.tenancy.id,
        action: options.action,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorLabel: actor.label,
        targetUserId: options.targetUserId ?? null,
        reason,
        metadata: options.metadata == null
          ? undefined
          : (sanitizeAuditMetadata(options.metadata) as Prisma.InputJsonValue),
      },
    });
  } catch (error) {
    // Audit is best-effort. Failing the caller here would make a succeeded
    // action look failed, which causes retries (double refunds) and
    // compensating rollbacks (impersonation sessions). Report it instead.
    captureError("admin-audit-log-write", new HexclaveAssertionError(
      "Failed to write admin audit log event; the audited action still succeeded.",
      { cause: error, auditAction: options.action },
    ));
  }
}

/**
 * Build metadata for project_settings.updated (path list + non-sensitive
 * before/after). Returns null when there is nothing to report.
 */
export function buildProjectSettingsAuditMetadata(options: {
  source: string,
  writeMode: "merge" | "replace",
  changedPaths: string[],
  beforeRoot: unknown,
  afterRoot: unknown,
  level?: "project" | "branch" | "environment",
}): Record<string, unknown> | null {
  if (options.changedPaths.length === 0) {
    return null;
  }
  const expandedPaths = expandConfigChangePaths({
    paths: options.changedPaths,
    beforeRoot: options.beforeRoot,
    afterRoot: options.afterRoot,
  });
  if (expandedPaths.length === 0) {
    return null;
  }
  const { changed_paths, changed_paths_truncated } = limitChangedPaths(expandedPaths);
  const changes = buildNonSensitiveFieldChanges({
    paths: changed_paths,
    beforeRoot: options.beforeRoot,
    afterRoot: options.afterRoot,
  });
  return {
    source: options.source,
    write_mode: options.writeMode,
    ...(options.level != null ? { level: options.level } : {}),
    changed_paths,
    ...(changed_paths_truncated ? { changed_paths_truncated: true } : {}),
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
  };
}

/**
 * Metadata for resource creates: changed_paths + after values (before is null).
 * Secrets stay path-only. Shape matches what the Compliance details column renders.
 */
export function buildCreatedFieldsAuditMetadata(options: {
  source: string,
  fields: Record<string, unknown>,
}): Record<string, unknown> | null {
  const afterRoot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options.fields)) {
    // Skip omitted and explicit-null creates (dashboard often posts null for
    // unused metadata). Logging `+ null` just noise in the audit UI.
    if (value !== undefined && value !== null) {
      afterRoot[key] = value;
    }
  }
  const changedPaths = collectConfigPaths(afterRoot);
  if (changedPaths.length === 0) {
    return null;
  }
  const { changed_paths, changed_paths_truncated } = limitChangedPaths(changedPaths);
  // Empty beforeRoot → normalizeAuditJsonValue(undefined) → null, so UI shows
  // green "+ value" rows for each non-sensitive leaf.
  const changes = buildNonSensitiveFieldChanges({
    paths: changed_paths,
    beforeRoot: {},
    afterRoot,
  });
  return {
    source: options.source,
    changed_paths,
    ...(changed_paths_truncated ? { changed_paths_truncated: true } : {}),
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
  };
}

/**
 * Metadata for resource updates: leaf paths from the patch + before/after from
 * full snapshots. Secrets stay path-only (same as settings / creates).
 */
export function buildUpdatedFieldsAuditMetadata(options: {
  source: string,
  patch: Record<string, unknown>,
  beforeRoot: unknown,
  afterRoot: unknown,
}): Record<string, unknown> | null {
  const changedPaths = collectConfigPaths(options.patch);
  if (changedPaths.length === 0) {
    return null;
  }
  const { changed_paths, changed_paths_truncated } = limitChangedPaths(changedPaths);
  const changes = buildNonSensitiveFieldChanges({
    paths: changed_paths,
    beforeRoot: options.beforeRoot,
    afterRoot: options.afterRoot,
  });
  return {
    source: options.source,
    changed_paths,
    ...(changed_paths_truncated ? { changed_paths_truncated: true } : {}),
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
  };
}
