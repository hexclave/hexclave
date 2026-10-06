"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { useRouter } from "@/components/router";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SimpleTooltip,
  toast,
} from "@/components/ui";
import { CheckCircleIcon, CopyIcon, DotsThreeIcon, FunnelSimpleIcon, MagnifyingGlassIcon, XCircleIcon } from "@phosphor-icons/react";
import type { ServerUser } from "@hexclave/next";
import {
  DataGrid,
  useDataGridUrlState,
  useDataSource,
  type DataGridColumnDef,
  type DataGridDataSource,
  type DataGridExportField,
  type DataGridExportScope,
} from "@hexclave/dashboard-ui-components";
import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";
import { Link } from "../link";
import { CreateCheckoutDialog } from "../payments/create-checkout-dialog";
import { DeleteUserDialog, ImpersonateUserDialog } from "../user-dialogs";

// ─── Types ───────────────────────────────────────────────────────────

export type ExtendedServerUser = ServerUser & {
  authTypes: string[],
  emailVerified: "verified" | "unverified",
};

type FilterState = {
  search: string,
  includeRestricted: boolean,
  includeAnonymous: boolean,
  onlyAnonymous: boolean,
  excludedEmailDomains: string[],
  signedUpOrder: "asc" | "desc",
};

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;
// Keep in sync with the backend list-users parser. This validates exact domains only;
// excluding gmail.com intentionally does not exclude mail.gmail.com.
const emailDomainRegex = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const maxExcludedEmailDomains = 100;
const DEFAULT_FILTERS: FilterState = {
  search: "",
  includeRestricted: true,
  includeAnonymous: false,
  onlyAnonymous: false,
  excludedEmailDomains: [],
  signedUpOrder: "desc",
};

const EXTERNAL_AUTH_PROVIDER_LABELS = new Map<string, string>([
  ["clerk-integration", "Clerk"],
  ["workos-integration", "WorkOS"],
  ["better-auth-integration", "Better Auth"],
]);

/** Display name of an external-auth provider ID, shared by the users table and the user detail page. */
export function getExternalAuthProviderLabel(providerId: string): string {
  return EXTERNAL_AUTH_PROVIDER_LABELS.get(providerId) ?? "External provider";
}

const AUTH_TYPE_LABELS = new Map<string, string>([
  ["anonymous", "Anonymous"],
  ["otp", "Authenticator"],
  ["password", "Password"],
  ...EXTERNAL_AUTH_PROVIDER_LABELS,
]);

// ─── Helpers ─────────────────────────────────────────────────────────

export function extendUsers(users: ServerUser[]): ExtendedServerUser[] {
  return users.map((user) => {
    const authTypes = user.isAnonymous
      ? ["anonymous"]
      : [
        ...(user.otpAuthEnabled ? ["otp"] : []),
        ...(user.hasPassword ? ["password"] : []),
        ...user.oauthProviders.map((provider) => provider.id),
        ...user.externalAuthProviders.map((provider) => getExternalAuthProviderLabel(provider.id)),
      ];
    return {
      ...user,
      authTypes,
      emailVerified: user.primaryEmailVerified ? "verified" : "unverified",
    } satisfies ExtendedServerUser;
  });
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatUserId(id: string) {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function normalizeEmailDomain(domain: string) {
  return domain.trim().replace(/^@/, "").toLowerCase();
}

function parseEmailDomains(input: string) {
  const domains = input.split(/[,\n]+/).map(normalizeEmailDomain).filter((domain) => domain !== "");
  const invalidDomain = domains.find((domain) => !emailDomainRegex.test(domain));
  if (invalidDomain != null) {
    return {
      domains: [],
      error: `Use exact domains like gmail.com. "${invalidDomain}" is not valid.`,
    };
  }
  return {
    domains,
    error: null,
  };
}

// ─── Column definitions ──────────────────────────────────────────────

function createUserTableColumns(
  onUserMutated: () => void | Promise<void>,
): DataGridColumnDef<ExtendedServerUser>[] {
  return [
    {
      id: "user",
      header: "User",
      width: 180,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => <UserIdentityCell user={row} />,
    },
    {
      id: "email",
      header: "Email",
      width: 180,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => <UserEmailCell user={row} />,
    },
    {
      id: "userId",
      header: "User ID",
      width: 130,
      sortable: false,
      renderCell: ({ row }) => <UserIdCell user={row} />,
    },
    {
      id: "emailStatus",
      header: "Email Verified",
      width: 110,
      sortable: false,
      renderCell: ({ row }) => <EmailStatusCell user={row} />,
    },
    {
      id: "lastActiveAt",
      header: "Last active",
      width: 110,
      renderCell: ({ row }) => <DateMetaCell value={row.lastActiveAt} emptyLabel="Never" />,
    },
    {
      id: "auth",
      header: "Auth methods",
      width: 150,
      sortable: false,
      cellOverflow: "wrap",
      renderCell: ({ row }) => <AuthMethodsCell user={row} />,
    },
    {
      id: "signedUpAt",
      header: "Signed up",
      width: 110,
      renderCell: ({ row }) => <DateMetaCell value={row.signedUpAt} emptyLabel="Unknown" />,
    },
    {
      id: "actions",
      header: "",
      width: 44,
      minWidth: 44,
      maxWidth: 44,
      sortable: false,
      hideable: false,
      resizable: false,
      align: "right",
      renderCell: ({ row }) => <UserActions user={row} onUserMutated={onUserMutated} />,
    },
  ];
}

const USER_EXPORT_FIELDS: DataGridExportField<ExtendedServerUser>[] = [
  { key: "id", label: "User ID", enabled: true, getValue: (user) => user.id },
  { key: "displayName", label: "Display Name", enabled: true, getValue: (user) => user.displayName ?? "" },
  { key: "primaryEmail", label: "Email", enabled: true, getValue: (user) => user.primaryEmail ?? "" },
  { key: "primaryEmailVerified", label: "Email Verified", enabled: true, getValue: (user) => user.primaryEmailVerified ? "Yes" : "No" },
  { key: "signedUpAt", label: "Signed Up At", enabled: true, getValue: (user) => new Date(user.signedUpAt).toISOString() },
  { key: "lastActiveAt", label: "Last Active At", enabled: true, getValue: (user) => new Date(user.lastActiveAt).toISOString() },
  { key: "isAnonymous", label: "Is Anonymous", enabled: false, getValue: (user) => user.isAnonymous ? "Yes" : "No" },
  { key: "hasPassword", label: "Has Password", enabled: false, getValue: (user) => user.hasPassword ? "Yes" : "No" },
  { key: "otpAuthEnabled", label: "OTP Auth Enabled", enabled: false, getValue: (user) => user.otpAuthEnabled ? "Yes" : "No" },
  { key: "passkeyAuthEnabled", label: "Passkey Auth Enabled", enabled: false, getValue: (user) => user.passkeyAuthEnabled ? "Yes" : "No" },
  { key: "isMultiFactorRequired", label: "Multi-Factor Required", enabled: false, getValue: (user) => user.isMultiFactorRequired ? "Yes" : "No" },
  { key: "oauthProviders", label: "OAuth Providers", enabled: false, getValue: (user) => user.oauthProviders.map((provider) => provider.id).join(", ") },
  { key: "externalAuthProviders", label: "External Auth Providers", enabled: false, getValue: (user) => user.externalAuthProviders.map((provider) => getExternalAuthProviderLabel(provider.id)).join(", ") },
  { key: "profileImageUrl", label: "Profile Image URL", enabled: false, getValue: (user) => user.profileImageUrl ?? "" },
  { key: "clientMetadata", label: "Client Metadata", enabled: false, getValue: (user) => JSON.stringify(user.clientMetadata ?? {}) },
  { key: "clientReadOnlyMetadata", label: "Client Read-Only Metadata", enabled: false, getValue: (user) => JSON.stringify(user.clientReadOnlyMetadata ?? {}) },
  { key: "serverMetadata", label: "Server Metadata", enabled: false, getValue: (user) => JSON.stringify(user.serverMetadata ?? {}) },
];

// ─── UserTable ───────────────────────────────────────────────────────

export function UserTable(props: {
  onUserMutated: () => void | Promise<void>,
  onReloadChange?: (reload: () => void) => void,
}) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);

  return <UserTableBody filters={filters} setFilters={setFilters} onUserMutated={props.onUserMutated} onReloadChange={props.onReloadChange} />;
}

// ─── Body (imperative fetching — no Suspense flash) ──────────────────

function UserTableBody(props: {
  filters: FilterState,
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>,
  onUserMutated: () => void | Promise<void>,
  onReloadChange?: (reload: () => void) => void,
}) {
  const { filters, setFilters, onUserMutated, onReloadChange } = props;
  const hexclaveAdminApp = useAdminApp();
  const router = useRouter();
  const columns = useMemo(() => createUserTableColumns(onUserMutated), [onUserMutated]);

  const [gridState, setGridState] = useDataGridUrlState(columns, {
    paramPrefix: "users",
    initial: {
      sorting: [{ columnId: "signedUpAt", direction: DEFAULT_FILTERS.signedUpOrder }],
    },
  });

  // Sync the sort header back into `filters` so the parent can persist it.
  const sortDirection = gridState.sorting.find((s) => s.columnId === "signedUpAt")?.direction ?? "desc";
  useEffect(() => {
    setFilters((prev) => (
      prev.signedUpOrder === sortDirection
        ? prev
        : { ...prev, signedUpOrder: sortDirection }
    ));
  }, [sortDirection, setFilters]);

  // Debounce the toolbar search input before it hits the server. The
  // visible input still updates instantly (via `gridState.quickSearch`);
  // only the fetch parameter is delayed.
  const [debouncedQuickSearch] = useDebounce(gridState.quickSearch.trim(), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    setFilters((prev) => (
      prev.search === debouncedQuickSearch
        ? prev
        : { ...prev, search: debouncedQuickSearch }
    ));
  }, [debouncedQuickSearch, setFilters]);

  // Server-side infinite data source. Re-created whenever a filter that
  // affects the query changes; useDataSource refetches from scratch on
  // identity change and continues paginating via the yielded nextCursor.
  const dataSource = useMemo<DataGridDataSource<ExtendedServerUser>>(
    () => async function* (params) {
      const search = typeof params.quickSearch === "string" && params.quickSearch.trim().length > 0
        ? params.quickSearch.trim()
        : undefined;
      const activeSort = params.sorting.find(
        (s) => s.columnId === "signedUpAt" || s.columnId === "lastActiveAt",
      );
      const orderBy: "signedUpAt" | "lastActiveAt" = activeSort?.columnId === "lastActiveAt"
        ? "lastActiveAt"
        : "signedUpAt";
      const sortDesc = activeSort?.direction !== "asc";
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const result = filters.onlyAnonymous
        ? await hexclaveAdminApp.listUsers({
          limit: PAGE_SIZE,
          orderBy,
          desc: sortDesc,
          query: search,
          excludedEmailDomains: filters.excludedEmailDomains,
          includeRestricted: filters.includeRestricted,
          includeAnonymous: true,
          onlyAnonymous: true,
          cursor,
        })
        : await hexclaveAdminApp.listUsers({
          limit: PAGE_SIZE,
          orderBy,
          desc: sortDesc,
          query: search,
          excludedEmailDomains: filters.excludedEmailDomains,
          includeRestricted: filters.includeRestricted,
          includeAnonymous: filters.includeAnonymous,
          cursor,
        });
      yield {
        rows: extendUsers(result),
        hasMore: result.nextCursor != null,
        nextCursor: result.nextCursor ?? undefined,
      };
    },
    [hexclaveAdminApp, filters.includeRestricted, filters.includeAnonymous, filters.onlyAnonymous, filters.excludedEmailDomains],
  );

  const getRowId = useCallback((row: ExtendedServerUser) => row.id, []);

  const gridData = useDataSource({
    dataSource,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: debouncedQuickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  useEffect(() => {
    onReloadChange?.(gridData.reload);
    return () => onReloadChange?.(() => {});
  }, [gridData.reload, onReloadChange]);

  const handleResetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setGridState((prev) => ({
      ...prev,
      quickSearch: "",
      sorting: [{ columnId: "signedUpAt", direction: DEFAULT_FILTERS.signedUpOrder }],
    }));
  }, [setFilters, setGridState]);

  const filterValue = filters.onlyAnonymous ? "anonymous-only" : filters.includeAnonymous ? "anonymous" : filters.includeRestricted ? "restricted" : "standard";
  const fetchExportRows = useCallback(async (options: {
    scope: DataGridExportScope,
    onProgress: (fetched: number) => void,
  }) => {
    const allUsers: ServerUser[] = [];
    let cursor: string | undefined = undefined;
    const limit = 100;
    const useFilters = options.scope === "filtered";

    do {
      type ListUsersOptions = Exclude<Parameters<typeof hexclaveAdminApp.listUsers>[0], undefined>;
      const baseListUsersOptions = {
        limit,
        cursor,
        query: useFilters ? (filters.search || undefined) : undefined,
        excludedEmailDomains: useFilters ? filters.excludedEmailDomains : undefined,
        includeRestricted: useFilters ? filters.includeRestricted : undefined,
        orderBy: "signedUpAt",
        desc: true,
      } satisfies Omit<ListUsersOptions, "includeAnonymous" | "onlyAnonymous">;
      const listUsersOptions: ListUsersOptions = useFilters && filters.onlyAnonymous
        ? { ...baseListUsersOptions, includeAnonymous: true, onlyAnonymous: true }
        : { ...baseListUsersOptions, includeAnonymous: useFilters ? filters.includeAnonymous : true };
      const batch = await hexclaveAdminApp.listUsers(listUsersOptions);

      allUsers.push(...batch);
      options.onProgress(allUsers.length);
      cursor = batch.nextCursor ?? undefined;
    } while (cursor);

    return extendUsers(allUsers);
  }, [hexclaveAdminApp, filters.excludedEmailDomains, filters.includeAnonymous, filters.includeRestricted, filters.onlyAnonymous, filters.search]);

  const toolbarExtra = (
    <div className="flex items-center gap-2">
      <EmailDomainFilter
        domains={filters.excludedEmailDomains}
        onChange={(excludedEmailDomains) => setFilters((prev) => ({ ...prev, excludedEmailDomains }))}
      />
      <Select
        value={filterValue}
        onValueChange={(value) => {
          if (value === "anonymous-only") {
            setFilters((prev) => ({ ...prev, includeRestricted: true, includeAnonymous: true, onlyAnonymous: true }));
          } else if (value === "anonymous") {
            setFilters((prev) => ({ ...prev, includeRestricted: true, includeAnonymous: true, onlyAnonymous: false }));
          } else if (value === "restricted") {
            setFilters((prev) => ({ ...prev, includeRestricted: true, includeAnonymous: false, onlyAnonymous: false }));
          } else {
            setFilters((prev) => ({ ...prev, includeRestricted: false, includeAnonymous: false, onlyAnonymous: false }));
          }
        }}
      >
        <SelectTrigger className="w-[180px] h-8 text-xs" aria-label="User list filter">
          <SelectValue placeholder="Signups" />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="standard">Exclude restricted</SelectItem>
          <SelectItem value="restricted">Signups</SelectItem>
          <SelectItem value="anonymous">Signups & anonymous</SelectItem>
          <SelectItem value="anonymous-only">Only anonymous</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <DataGrid
      columns={columns}
      rows={gridData.rows}
      getRowId={getRowId}
      isLoading={gridData.isLoading}
      isRefetching={gridData.isRefetching}
      state={gridState}
      onChange={setGridState}
      paginationMode="infinite"
      hasMore={gridData.hasMore}
      isLoadingMore={gridData.isLoadingMore}
      onLoadMore={gridData.loadMore}
      rowHeight="auto"
      estimatedRowHeight={44}
      footer={false}
      fillHeight={false}
      toolbarExtra={toolbarExtra}
      exportOptions={{
        title: "Export Users",
        description: "Configure and download user data from your project",
        entityName: "user",
        entityNamePlural: "users",
        filenamePrefix: "stack-users-export",
        fields: USER_EXPORT_FIELDS,
        fetchRows: fetchExportRows,
        emptyExportTitle: "No users to export",
        emptyExportDescription: "There are no users matching the current filters",
        defaultScope: "filtered",
        allScopeLabel: "Export all users in the project (includes Anonymous)",
        filteredScopeLabel: (
          <>
            Export only filtered/searched users
            {filters.search && (
              <span className="text-muted-foreground ml-1">
                (search: &quot;{filters.search}&quot;)
              </span>
            )}
          </>
        ),
      }}
      onRowClick={(row) => {
        router.push(`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/users/${encodeURIComponent(row.id)}`);
      }}
      emptyState={
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <MagnifyingGlassIcon className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="text-base font-medium text-foreground">No users found</div>
          <p className="text-sm text-muted-foreground">Try adjusting your search or filters</p>
          <Button
            variant="outline"
            onClick={handleResetFilters}
          >
            Reset filters
          </Button>
        </div>
      }
    />
  );
}

function EmailDomainFilter(props: {
  domains: string[],
  onChange: (domains: string[]) => void,
}) {
  const { domains, onChange } = props;
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addDomains = useCallback((rawInput: string) => {
    const parsed = parseEmailDomains(rawInput);
    if (parsed.error != null) {
      setError(parsed.error);
      return;
    }
    if (parsed.domains.length === 0) {
      setInput("");
      setError(null);
      return;
    }

    const nextDomains = new Map(domains.map((domain) => [domain, true]));
    for (const domain of parsed.domains) {
      nextDomains.set(domain, true);
    }
    if (nextDomains.size > maxExcludedEmailDomains) {
      setError(`You can exclude at most ${maxExcludedEmailDomains} domains.`);
      return;
    }
    onChange([...nextDomains.keys()]);
    setInput("");
    setError(null);
  }, [domains, onChange]);

  const removeDomain = useCallback((domainToRemove: string) => {
    onChange(domains.filter((domain) => domain !== domainToRemove));
    setError(null);
  }, [domains, onChange]);

  const active = domains.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-xl border-black/[0.08] bg-white/85 px-3 text-xs shadow-sm ring-1 ring-black/[0.08] hover:bg-white dark:border-white/[0.06] dark:bg-foreground/[0.03] dark:ring-white/[0.06] dark:hover:bg-foreground/[0.06]"
          aria-label="Exclude email domains"
        >
          <FunnelSimpleIcon className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
          Exclude by Email
          {active ? (
            <Badge variant="secondary" className="ml-2 rounded-full px-1.5 py-0 text-[10px] font-medium">
              {domains.length}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[320px] rounded-xl border-black/[0.08] bg-white/95 p-3 shadow-md ring-1 ring-black/[0.08] backdrop-blur-xl dark:border-white/[0.06] dark:bg-background/95 dark:ring-white/[0.06]"
      >
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium text-foreground">Exclude email domains</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Hide users whose primary email uses one of these domains.
            </p>
          </div>
          <Input
            size="sm"
            value={input}
            placeholder="gmail.com, yahoo.com"
            aria-label="Excluded email domains"
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addDomains(input);
              }
            }}
            onPaste={(event) => {
              const pastedText = event.clipboardData.getData("text");
              if (pastedText.includes(",") || pastedText.includes("\n")) {
                event.preventDefault();
                addDomains(pastedText);
              }
            }}
            onBlur={() => {
              if (input.trim() !== "") {
                addDomains(input);
              }
            }}
          />
          {error != null ? (
            <div className="text-xs text-destructive">{error}</div>
          ) : null}
          {domains.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {domains.map((domain) => (
                <Badge key={domain} variant="secondary" className="gap-1 rounded-full px-2 py-0.5 text-xs">
                  {domain}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeDomain(domain)}
                    aria-label={`Remove ${domain}`}
                  >
                    <XCircleIcon className="h-3.5 w-3.5" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No domains excluded.</div>
          )}
          {domains.length > 0 ? (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => onChange([])}>
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Cell components ─────────────────────────────────────────────────

function UserActions(props: {
  user: ExtendedServerUser,
  onUserMutated: () => void | Promise<void>,
}) {
  const { user, onUserMutated } = props;
  const hexclaveAdminApp = useAdminApp();
  const router = useRouter();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [impersonateOpen, setImpersonateOpen] = useState(false);
  const profileUrl = `/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/users/${encodeURIComponent(user.id)}`;

  return (
    <div
      className="flex justify-end"
      data-no-row-click
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <DeleteUserDialog user={user} open={isDeleteOpen} onOpenChange={setIsDeleteOpen} profileHref={profileUrl} onDeleted={onUserMutated} />
      <ImpersonateUserDialog user={user} adminApp={hexclaveAdminApp} open={impersonateOpen} onClose={() => setImpersonateOpen(false)} />
      <CreateCheckoutDialog
        open={isCheckoutOpen}
        onOpenChange={setIsCheckoutOpen}
        customer={{ type: "user", id: user.id, label: user.displayName ?? user.primaryEmail ?? user.id }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="User actions">
            <DotsThreeIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => router.push(profileUrl)}
          >
            View details
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setImpersonateOpen(true)}
          >
            Impersonate
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setIsCheckoutOpen(true)}>Create checkout</DropdownMenuItem>
          {user.isMultiFactorRequired && (
            <DropdownMenuItem
              onClick={() =>
                runAsynchronouslyWithAlert(async () => {
                  await user.update({ totpMultiFactorSecret: null });
                  runAsynchronouslyWithAlert(Promise.resolve().then(() => onUserMutated()));
                })
              }
            >
              Remove 2FA
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setIsDeleteOpen(true)} className="text-destructive focus:text-destructive">
            Delete user
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function UserIdentityCell(props: { user: ExtendedServerUser }) {
  const { user } = props;
  const hexclaveAdminApp = useAdminApp();
  const profileUrl = `/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/users/${encodeURIComponent(user.id)}`;
  const fallback = user.displayName?.charAt(0) ?? user.primaryEmail?.charAt(0) ?? "?";
  const displayName = user.displayName ?? user.primaryEmail ?? "Unnamed user";

  return (
    <div className="flex items-center gap-3">
      <Link href={profileUrl} className="rounded-full shrink-0" prefetch={false}>
        <Avatar className="h-6 w-6">
          <AvatarImage src={user.profileImageUrl ?? undefined} alt={user.displayName ?? user.primaryEmail ?? "User avatar"} />
          <AvatarFallback>{fallback}</AvatarFallback>
        </Avatar>
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          href={profileUrl}
          prefetch={false}
          className="block truncate text-sm font-semibold text-foreground hover:text-foreground"
          title={displayName}
        >
          {displayName}
        </Link>
      </div>
      {user.isAnonymous && (
        <Badge variant="secondary" className="text-xs shrink-0">Anonymous</Badge>
      )}
    </div>
  );
}

function UserIdCell(props: { user: ExtendedServerUser }) {
  const { user } = props;
  return (
    <SimpleTooltip tooltip="Copy user ID">
      <Button
        type="button"
        onClick={() => runAsynchronouslyWithAlert(async () => {
          await navigator.clipboard.writeText(user.id);
          toast({ title: "Copied to clipboard", variant: "success" });
        })}
        className="flex max-w-full px-1 py-0 h-min items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:transition-none hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer bg-transparent hover:bg-transparent"
        aria-label="Copy user ID"
        title={user.id}
      >
        <span className="truncate">{formatUserId(user.id)}</span>
        <CopyIcon className="h-3 w-3 shrink-0" />
      </Button>
    </SimpleTooltip>
  );
}

function UserEmailCell(props: { user: ExtendedServerUser }) {
  return (
    <span className="block max-w-full truncate text-sm text-muted-foreground" title={props.user.primaryEmail ?? undefined}>
      {props.user.primaryEmail ?? "No email"}
    </span>
  );
}

function EmailStatusCell(props: { user: ExtendedServerUser }) {
  const isVerified = props.user.emailVerified === "verified";
  return (
    <div className="flex items-center">
      {isVerified ? (
        <CheckCircleIcon className="h-4 w-4 text-success" aria-label="Email verified" />
      ) : (
        <XCircleIcon className="h-4 w-4 text-amber-500" aria-label="Email unverified" />
      )}
    </div>
  );
}

function AuthMethodsCell(props: { user: ExtendedServerUser }) {
  const authLabels = props.user.authTypes.length > 0 ? props.user.authTypes : ["none"];
  return (
    <div className="flex flex-wrap gap-1">
      {authLabels.map((type) => (
        <Badge key={type} variant="outline" className="bg-muted/60 text-[11px] text-muted-foreground px-1.5 py-0">
          {type === "none" ? "None" : AUTH_TYPE_LABELS.get(type) ?? titleCase(type)}
        </Badge>
      ))}
    </div>
  );
}

function DateMetaCell(props: { value: Date | string | null | undefined, emptyLabel: string }) {
  const { value, emptyLabel } = props;
  if (!value) return <span className="text-sm text-muted-foreground">{emptyLabel}</span>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-sm text-muted-foreground">{emptyLabel}</span>;
  return (
    <span className="text-sm text-muted-foreground whitespace-nowrap" title={date.toString()}>
      {fromNow(date)}
    </span>
  );
}
