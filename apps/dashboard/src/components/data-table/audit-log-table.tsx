"use client";

import { Link } from "@/components/link";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  DataGrid,
  useDataGridUrlState,
  useDataSource,
  type DataGridColumnDef,
} from "@hexclave/dashboard-ui-components";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { CaretDownIcon, CaretRightIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

export type AuditLogAction =
  | "impersonation.started"
  | "impersonation.revoked"
  | "project_settings.updated"
  | "user.created"
  | "user.deleted"
  | "user.updated"
  | "user.restricted"
  | "user.unrestricted"
  | "user.password.set"
  | "user.mfa.enabled"
  | "user.mfa.removed"
  | "user.password_reset.sent"
  | "user.sign_in_invitation.sent"
  | "contact_channel.created"
  | "contact_channel.updated"
  | "contact_channel.deleted"
  | "contact_channel.verification.sent"
  | "project_api_key.created"
  | "project_api_key.updated"
  | "project_api_key.revoked"
  | "config_source.unlinked"
  | "team.created"
  | "team.updated"
  | "team.deleted"
  | "team_membership.created"
  | "team_membership.deleted"
  | "team_permission.granted"
  | "team_permission.revoked"
  | "permission_definition.created"
  | "permission_definition.updated"
  | "permission_definition.deleted"
  | "project_permission.granted"
  | "project_permission.revoked"
  | "payment.checkout.created"
  | "payment.item_quantity.changed"
  | "payment.refund.created"
  | "payment.stripe.setup_started"
  | "payment.method_config.updated"
  | "email.template.created"
  | "email.template.updated"
  | "email.template.deleted"
  | "email.theme.created"
  | "email.theme.updated"
  | "email.theme.deleted"
  | "email.draft.created"
  | "email.draft.updated"
  | "email.draft.deleted"
  | "email.managed_domain.setup_started"
  | "email.managed_domain.applied"
  | "email.managed_domain.deleted";

export type AuditLogEvent = {
  id: string,
  created_at_millis: number,
  action: AuditLogAction,
  actor_type: "admin_user" | "server_key" | "unknown",
  actor_user_id: string | null,
  actor_label: string,
  target_user_id: string | null,
  reason: string | null,
  metadata: unknown,
};

type AuditFieldChange = {
  before: unknown,
  after: unknown,
};

type ParsedDetails =
  | { kind: "empty" }
  | { kind: "reason", reason: string }
  | {
    kind: "changes",
    paths: string[],
    changes: Record<string, AuditFieldChange> | null,
    truncated: boolean,
  };

function formatAction(action: AuditLogAction): string {
  switch (action) {
    case "impersonation.started": {
      return "Impersonation started";
    }
    case "impersonation.revoked": {
      return "Impersonation revoked";
    }
    case "project_settings.updated": {
      return "Project settings updated";
    }
    case "user.created": {
      return "User created";
    }
    case "user.deleted": {
      return "User deleted";
    }
    case "user.updated": {
      return "User updated";
    }
    case "user.restricted": {
      return "User restricted";
    }
    case "user.unrestricted": {
      return "User unrestricted";
    }
    case "user.password.set": {
      return "User password set";
    }
    case "user.mfa.enabled": {
      return "User MFA enabled";
    }
    case "user.mfa.removed": {
      return "User MFA removed";
    }
    case "user.password_reset.sent": {
      return "Password reset email sent";
    }
    case "user.sign_in_invitation.sent": {
      return "Sign-in invitation sent";
    }
    case "contact_channel.created": {
      return "Contact channel created";
    }
    case "contact_channel.updated": {
      return "Contact channel updated";
    }
    case "contact_channel.deleted": {
      return "Contact channel deleted";
    }
    case "contact_channel.verification.sent": {
      return "Verification email sent";
    }
    case "project_api_key.created": {
      return "Project API key created";
    }
    case "project_api_key.updated": {
      return "Project API key updated";
    }
    case "project_api_key.revoked": {
      return "Project API key revoked";
    }
    case "config_source.unlinked": {
      return "Config source unlinked";
    }
    case "team.created": {
      return "Team created";
    }
    case "team.updated": {
      return "Team updated";
    }
    case "team.deleted": {
      return "Team deleted";
    }
    case "team_membership.created": {
      return "Team member added";
    }
    case "team_membership.deleted": {
      return "Team member removed";
    }
    case "team_permission.granted": {
      return "Team permission granted";
    }
    case "team_permission.revoked": {
      return "Team permission revoked";
    }
    case "permission_definition.created": {
      return "Permission definition created";
    }
    case "permission_definition.updated": {
      return "Permission definition updated";
    }
    case "permission_definition.deleted": {
      return "Permission definition deleted";
    }
    case "project_permission.granted": {
      return "Project permission granted";
    }
    case "project_permission.revoked": {
      return "Project permission revoked";
    }
    case "payment.checkout.created": {
      return "Checkout created";
    }
    case "payment.item_quantity.changed": {
      return "Item quantity changed";
    }
    case "payment.refund.created": {
      return "Refund created";
    }
    case "payment.stripe.setup_started": {
      return "Stripe setup started";
    }
    case "payment.method_config.updated": {
      return "Payment methods updated";
    }
    case "email.template.created": {
      return "Email template created";
    }
    case "email.template.updated": {
      return "Email template updated";
    }
    case "email.template.deleted": {
      return "Email template deleted";
    }
    case "email.theme.created": {
      return "Email theme created";
    }
    case "email.theme.updated": {
      return "Email theme updated";
    }
    case "email.theme.deleted": {
      return "Email theme deleted";
    }
    case "email.draft.created": {
      return "Email draft created";
    }
    case "email.draft.updated": {
      return "Email draft updated";
    }
    case "email.draft.deleted": {
      return "Email draft deleted";
    }
    case "email.managed_domain.setup_started": {
      return "Managed email domain setup started";
    }
    case "email.managed_domain.applied": {
      return "Managed email domain applied";
    }
    case "email.managed_domain.deleted": {
      return "Managed email domain deleted";
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

const FIELD_LABELS = new Map<string, string>([
  ["primary_email", "Primary email"],
  ["primary_email_verified", "Email verified"],
  ["primary_email_auth_enabled", "Password sign-in"],
  ["display_name", "Display name"],
  ["password", "Password"],
  ["country_code", "Country"],
  ["signed_up_at_millis", "Signed up"],
  ["is_anonymous", "Anonymous"],
  ["client_metadata", "Client metadata"],
  ["client_read_only_metadata", "Client read-only metadata"],
  ["server_metadata", "Server metadata"],
  ["profile_image_url", "Profile image"],
  ["totp_secret_base64", "MFA secret"],
  ["restricted_by_admin", "Restricted by admin"],
  ["restricted_by_admin_reason", "Restriction reason"],
  ["risk_scores.sign_up.bot", "Sign-up bot risk"],
  ["risk_scores.sign_up.free_trial_abuse", "Free-trial abuse risk"],
  ["api_key_id", "API key ID"],
  ["description", "Description"],
  ["expires_at_millis", "Expires"],
  ["has_publishable_client_key", "Publishable client key"],
  ["has_secret_server_key", "Secret server key"],
  ["has_super_secret_admin_key", "Super secret admin key"],
  ["type", "Source type"],
  ["owner", "GitHub owner"],
  ["repo", "GitHub repo"],
  ["branch", "GitHub branch"],
  ["commit_hash", "Commit"],
  ["config_file_path", "Config file path"],
  ["workflow_path", "Workflow path"],
  ["team_id", "Team ID"],
  ["user_id", "User ID"],
  ["permission_id", "Permission"],
  ["creator_user_id", "Creator user ID"],
  ["product_id", "Product"],
  ["item_id", "Item"],
  ["quantity", "Quantity"],
  ["delta", "Delta"],
  ["allow_negative", "Allow negative"],
  ["expires_at", "Expires"],
  ["has_product_inline", "Inline product"],
  ["granted_permission_ids", "Granted permissions"],
  ["scope", "Scope"],
  ["contained_permission_ids", "Contained permissions"],
  ["old_permission_id", "Previous permission ID"],
  ["customer_type", "Customer type"],
  ["customer_id", "Customer ID"],
  ["amount_usd", "Amount (USD)"],
  ["end_action", "End action"],
  ["refund_transaction_id", "Refund transaction"],
  ["purchase_type", "Purchase type"],
  ["purchase_id", "Purchase ID"],
  ["invoice_id", "Invoice ID"],
  ["stripe_account_created", "Stripe account created"],
  ["config_id", "Config ID"],
  ["template_id", "Template"],
  ["theme_id", "Theme"],
  ["draft_id", "Draft"],
  ["tsx_source_updated", "Source updated"],
  ["subdomain", "Subdomain"],
  ["sender_local_part", "Sender local part"],
  ["domain_id", "Domain"],
  ["status", "Status"],
  ["provider", "Provider"],
]);

const OAUTH_PROVIDER_FIELD_LABELS = new Map<string, string>([
  ["type", "Type"],
  ["isShared", "Shared keys"],
  ["clientId", "Client ID"],
  ["clientSecret", "Client secret"],
  ["allowSignIn", "Sign-in"],
  ["allowConnectedAccounts", "Connected accounts"],
  ["customCallbackUrl", "Callback URL"],
  ["facebookConfigId", "Facebook config ID"],
  ["microsoftTenantId", "Microsoft tenant ID"],
  ["appleTeamId", "Apple team ID"],
  ["appleKeyId", "Apple key ID"],
  ["applePrivateKey", "Apple private key"],
  ["issuerUrl", "Issuer URL"],
  ["scope", "Scope"],
  ["displayName", "Display name"],
]);

const TRUSTED_DOMAIN_FIELD_LABELS = new Map<string, string>([
  ["baseUrl", "Base URL"],
  ["handlerPath", "Handler path"],
]);

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function humanizeSegment(segment: string): string {
  if (UUID_SEGMENT_RE.test(segment)) {
    // Full UUIDs dominate the label and hide the actual field/value.
    return `${segment.slice(0, 4)}…${segment.slice(-4)}`;
  }
  return segment
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => {
      // Preserve camelCase boundaries: facebookConfigId → Facebook Config Id
      const withSpaces = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
      return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
    })
    .join(" ");
}

function humanizeProviderId(providerId: string): string {
  if (providerId === "github") return "GitHub";
  if (providerId === "linkedin") return "LinkedIn";
  if (providerId === "apple") return "Apple";
  if (providerId === "microsoft") return "Microsoft";
  if (providerId === "google") return "Google";
  if (providerId === "facebook") return "Facebook";
  if (providerId === "spotify") return "Spotify";
  if (providerId === "x") return "X";
  return humanizeSegment(providerId);
}

type FieldPathParts = {
  /** Optional group header (e.g. "Trusted domain · 3bba…00d7"). */
  groupLabel: string | null,
  /** Short field label shown under the group (e.g. "Base URL"). */
  fieldLabel: string,
  /** Full single-line label for chips / ungrouped rows. */
  fullLabel: string,
};

function parseFieldPathParts(path: string): FieldPathParts {
  const known = FIELD_LABELS.get(path);
  if (known != null) {
    return { groupLabel: null, fieldLabel: known, fullLabel: known };
  }

  const oauthFieldMatch = /^auth\.oauth\.providers\.([^.]+)\.(.+)$/.exec(path);
  if (oauthFieldMatch != null) {
    const providerLabel = humanizeProviderId(oauthFieldMatch[1]);
    const groupLabel = `OAuth · ${providerLabel}`;
    const fieldPath = oauthFieldMatch[2];
    const fieldLabel = OAUTH_PROVIDER_FIELD_LABELS.get(fieldPath)
      ?? fieldPath.split(".").map(humanizeSegment).join(" · ");
    return {
      groupLabel,
      fieldLabel,
      fullLabel: `${groupLabel} · ${fieldLabel}`,
    };
  }
  const oauthProviderMatch = /^auth\.oauth\.providers\.([^.]+)$/.exec(path);
  if (oauthProviderMatch != null) {
    const groupLabel = `OAuth · ${humanizeProviderId(oauthProviderMatch[1])}`;
    return { groupLabel: null, fieldLabel: groupLabel, fullLabel: groupLabel };
  }

  const domainFieldMatch = /^domains\.trustedDomains\.([^.]+)\.(.+)$/.exec(path);
  if (domainFieldMatch != null) {
    const domainId = humanizeSegment(domainFieldMatch[1]);
    const groupLabel = `Trusted domain · ${domainId}`;
    const fieldPath = domainFieldMatch[2];
    const fieldLabel = TRUSTED_DOMAIN_FIELD_LABELS.get(fieldPath)
      ?? fieldPath.split(".").map(humanizeSegment).join(" · ");
    return {
      groupLabel,
      fieldLabel,
      fullLabel: `${groupLabel} · ${fieldLabel}`,
    };
  }
  const domainOnlyMatch = /^domains\.trustedDomains\.([^.]+)$/.exec(path);
  if (domainOnlyMatch != null) {
    const groupLabel = `Trusted domain · ${humanizeSegment(domainOnlyMatch[1])}`;
    return { groupLabel: null, fieldLabel: groupLabel, fullLabel: groupLabel };
  }

  const fullLabel = path.split(".").map(humanizeSegment).join(" · ");
  return { groupLabel: null, fieldLabel: fullLabel, fullLabel };
}

function humanizeFieldPath(path: string): string {
  return parseFieldPathParts(path).fullLabel;
}

type AuditPathGroup = {
  key: string,
  groupLabel: string | null,
  paths: string[],
};

/** Collapse sibling leaves under one header so UUIDs aren't repeated on every row. */
function groupChangePaths(paths: string[]): AuditPathGroup[] {
  const groups: AuditPathGroup[] = [];
  const indexByKey = new Map<string, number>();

  for (const path of paths) {
    const parts = parseFieldPathParts(path);
    const key = parts.groupLabel ?? path;
    const existing = indexByKey.get(key);
    if (existing != null) {
      groups[existing]?.paths.push(path);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push({
      key,
      groupLabel: parts.groupLabel,
      paths: [path],
    });
  }
  return groups;
}

function formatDisplayValue(value: unknown, path?: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (path != null && path.endsWith("_millis")) {
      return new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }
    return String(value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseDetails(event: AuditLogEvent): ParsedDetails {
  if (event.reason != null && event.reason !== "") {
    return { kind: "reason", reason: event.reason };
  }
  if (
    event.metadata == null
    || typeof event.metadata !== "object"
    || Array.isArray(event.metadata)
  ) {
    return { kind: "empty" };
  }
  const metadata = event.metadata as {
    changed_paths?: unknown,
    changed_paths_truncated?: unknown,
    changes?: unknown,
  };
  const paths = metadata.changed_paths;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    return { kind: "empty" };
  }
  const changes = metadata.changes != null
    && typeof metadata.changes === "object"
    && !Array.isArray(metadata.changes)
    ? metadata.changes as Record<string, AuditFieldChange>
    : null;
  return {
    kind: "changes",
    paths,
    changes,
    truncated: metadata.changed_paths_truncated === true,
  };
}

function visibleChangePaths(parsed: Extract<ParsedDetails, { kind: "changes" }>): string[] {
  return parsed.paths.filter((path) => {
    const change = parsed.changes?.[path];
    if (change == null) return true;
    // Hide empty create noise (`null` → `null` / `""` from shared oauth field bags).
    if (change.before === null && (change.after === null || change.after === "")) return false;
    return true;
  });
}

function summarizeChanges(paths: string[], truncated: boolean): string {
  const count = paths.length;
  if (count === 0) return truncated ? "Changes…" : "No field details";

  const groups = groupChangePaths(paths);
  // Prefer group-aware chip text: "Trusted domain · 3bba… · Base URL" not the full UUID path twice.
  if (groups.length === 1) {
    const group = groups[0] ?? throwErr("summarizeChanges: expected one group");
    if (group.groupLabel != null) {
      const fieldLabels = group.paths.map((path) => parseFieldPathParts(path).fieldLabel);
      if (fieldLabels.length === 1) {
        return `${group.groupLabel} · ${fieldLabels[0]}${truncated ? "…" : ""}`;
      }
      if (fieldLabels.length <= 3) {
        return `${group.groupLabel} · ${fieldLabels.join(" · ")}${truncated ? "…" : ""}`;
      }
      return `${group.groupLabel} · ${fieldLabels.length} fields${truncated ? "…" : ""}`;
    }
  }

  const previewLimit = 3;
  const labels = paths.slice(0, previewLimit).map(humanizeFieldPath);
  const preview = labels.join(" · ");
  if (count <= previewLimit && !truncated) return preview;
  return `${preview} · +${count - previewLimit}${truncated ? "…" : ""}`;
}

function formatDetails(event: AuditLogEvent): string {
  const parsed = parseDetails(event);
  switch (parsed.kind) {
    case "empty": {
      return "—";
    }
    case "reason": {
      return parsed.reason;
    }
    case "changes": {
      return summarizeChanges(visibleChangePaths(parsed), parsed.truncated);
    }
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
  }
}

function AuditDiffPills({
  path,
  before,
  after,
}: {
  path: string,
  before: unknown,
  after: unknown,
}) {
  const beforeIsEmpty = before === null;
  const beforeText = beforeIsEmpty ? "—" : formatDisplayValue(before, path);
  const afterIsRemoval = after === null;
  const afterText = afterIsRemoval ? "Removed" : formatDisplayValue(after, path);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span
        className={cn(
          "max-w-full rounded-md px-1.5 py-0.5 break-all",
          beforeIsEmpty
            ? "bg-foreground/[0.04] text-muted-foreground"
            : "bg-red-500/[0.08] text-red-700 line-through decoration-red-700/40 dark:text-red-300 dark:decoration-red-300/40",
        )}
        title={beforeText}
      >
        {beforeText}
      </span>
      <span className="text-muted-foreground" aria-hidden>→</span>
      <span
        className={cn(
          "max-w-full rounded-md px-1.5 py-0.5 font-medium break-all",
          afterIsRemoval
            ? "bg-red-500/[0.1] text-red-700 dark:text-red-300"
            : "bg-emerald-500/[0.1] text-emerald-800 dark:text-emerald-300",
        )}
        title={afterText}
      >
        {afterText}
      </span>
    </div>
  );
}

function AuditFieldRow({
  path,
  change,
}: {
  path: string,
  change: AuditFieldChange | null | undefined,
}) {
  // Always use the concise full label + before→after pills (same as "google → Removed").
  const label = humanizeFieldPath(path);

  if (change == null || !("before" in change) || !("after" in change)) {
    return (
      <div className="flex flex-col gap-1 py-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Badge variant="secondary" className="w-fit gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
          <EyeSlashIcon className="size-3" />
          Hidden
        </Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <AuditDiffPills path={path} before={change.before} after={change.after} />
    </div>
  );
}

/** Same glass surface as user-table filter popovers / design controls. */
const auditDetailsPopoverClassName = cn(
  "w-[min(28rem,calc(100vw-2rem))] rounded-xl border-black/[0.08] bg-white/95 p-0 shadow-md",
  "ring-1 ring-black/[0.08] backdrop-blur-xl",
  "dark:border-white/[0.06] dark:bg-background/95 dark:ring-white/[0.06]",
);

function AuditDetailsCell({ event }: { event: AuditLogEvent }) {
  const [open, setOpen] = useState(false);
  const parsed = parseDetails(event);
  if (parsed.kind === "empty") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (parsed.kind === "reason") {
    return (
      <span className="block truncate text-muted-foreground" title={parsed.reason}>
        {parsed.reason}
      </span>
    );
  }

  const paths = visibleChangePaths(parsed);
  const summary = summarizeChanges(paths, parsed.truncated);
  const actionLabel = formatAction(event.action);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 max-w-full justify-start gap-1.5 rounded-xl border-black/[0.08] bg-white/85 px-3 text-xs shadow-sm ring-1 ring-black/[0.08] hover:bg-white hover:transition-none dark:border-white/[0.06] dark:bg-foreground/[0.03] dark:ring-white/[0.06] dark:hover:bg-foreground/[0.06]",
            open && "bg-white ring-black/[0.14] dark:bg-foreground/[0.08] dark:ring-white/[0.14]",
          )}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details: ${summary}`}
        >
          {open ? (
            <CaretDownIcon className="size-3.5 shrink-0 text-muted-foreground" weight="bold" />
          ) : (
            <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground" weight="bold" />
          )}
          <span className="truncate font-medium text-foreground/80">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className={auditDetailsPopoverClassName}
      >
        <div className="border-b border-black/[0.06] px-3 py-2.5 dark:border-white/[0.06]">
          <div className="text-sm font-medium text-foreground">{actionLabel}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {paths.length} {paths.length === 1 ? "field" : "fields"}
            {parsed.truncated ? " · list truncated" : ""}
          </p>
        </div>
        <div className="max-h-72 divide-y divide-border/40 overflow-y-auto px-3">
          {paths.map((path) => (
            <AuditFieldRow
              key={path}
              path={path}
              change={parsed.changes?.[path]}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function getColumns(projectId: string): DataGridColumnDef<AuditLogEvent>[] {
  return [
    {
      id: "createdAt",
      header: "When",
      accessor: (row) => new Date(row.created_at_millis),
      type: "dateTime",
      width: 180,
      renderCell: ({ row }) => (
        <span className="truncate">
          {new Date(row.created_at_millis).toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      ),
    },
    {
      id: "action",
      header: "Action",
      accessor: (row) => formatAction(row.action),
      type: "string",
      width: 220,
      renderCell: ({ row }) => (
        <Badge variant="secondary">{formatAction(row.action)}</Badge>
      ),
    },
    {
      id: "actor",
      header: "Actor",
      accessor: "actor_label",
      type: "string",
      width: 180,
      flex: 1,
      renderCell: ({ row }) => (
        <span className="block truncate" title={row.actor_label}>{row.actor_label}</span>
      ),
    },
    {
      id: "target",
      header: "Target",
      accessor: (row) => row.target_user_id ?? "",
      type: "string",
      width: 200,
      // Absolute path required: relative `../users/...` from nested project pages
      // can drop the project id and 404.
      renderCell: ({ row }) => {
        if (row.target_user_id == null) {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(row.target_user_id)}`}
            className="block truncate underline underline-offset-2"
            title={row.target_user_id}
          >
            {row.target_user_id}
          </Link>
        );
      },
    },
    {
      id: "details",
      header: "Details",
      accessor: (row) => formatDetails(row),
      type: "string",
      width: 220,
      flex: 1.2,
      renderCell: ({ row }) => <AuditDetailsCell event={row} />,
    },
  ];
}

export function AuditLogTable(props: {
  events: AuditLogEvent[],
  projectId: string,
  isLoading?: boolean,
}) {
  const columns = useMemo(
    () => getColumns(props.projectId),
    [props.projectId],
  );

  const [gridState, setGridState] = useDataGridUrlState(columns, {
    paramPrefix: "auditlog",
    initial: { sorting: [{ columnId: "createdAt", direction: "desc" }] },
  });

  const gridData = useDataSource({
    data: props.events,
    columns,
    getRowId: (row) => row.id,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  return (
    <DataGrid
      columns={columns}
      rows={gridData.rows}
      getRowId={(row) => row.id}
      totalRowCount={gridData.totalRowCount}
      isLoading={props.isLoading === true || gridData.isLoading}
      state={gridState}
      onChange={setGridState}
      fillHeight={false}
    />
  );
}
