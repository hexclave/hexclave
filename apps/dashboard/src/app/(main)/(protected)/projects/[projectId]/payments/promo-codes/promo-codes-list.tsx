"use client";

import {
  DesignAlert,
  DesignBadge,
  type DesignBadgeColor,
  DesignButton,
} from "@/components/design-components";
import { ActionCell, ActionDialog, RadioGroup, RadioGroupItem, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui";
import { Label } from "@/components/ui/label";
import {
  DataGrid,
  useDataGridUrlState,
  useDataSource,
  type DataGridColumnDef,
  type DataGridDataSource,
} from "@hexclave/dashboard-ui-components";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { PageLayout } from "../../page-layout";

export type PromoCodeStatus = "active" | "scheduled" | "paused" | "expired" | "ended";
export type DiscountKind = "percent" | "fixed";
export type SubscriptionDiscountEndChoice = "keep" | "end_after_period";

export type PromoCodeRow = {
  id: string,
  codename: string,
  status: PromoCodeStatus,
  statusDetail: string | null,
  discountKind: DiscountKind,
  discountAmount: number,
  productsLabel: string,
  numRedemptions: number,
  maxRedemptions: number | null,
  availability: string,
  /**
   * Dummy stand-in for "this code still discounts live subscriptions."
   * TODO: Once PromoCodeRedemption is wired, derive this from redemptions
   * still applying a discount on renewals (`subscriptionBehavior` is
   * `forever` or `fixed_duration`, and the discount has not already been
   * removed). Do not show the radio group when that set is empty.
   */
  hasActiveSubscriptionRedemptions: boolean,
};

type StatusFilter = "all" | PromoCodeStatus;

const PAGE_SIZE = 25;

const STATUS_BADGE = new Map<PromoCodeStatus, { label: string, color: DesignBadgeColor }>([
  ["active", { label: "Active", color: "green" }],
  ["scheduled", { label: "Scheduled", color: "cyan" }],
  ["paused", { label: "Paused", color: "blue" }],
  ["expired", { label: "Expired", color: "red" }],
  ["ended", { label: "Ended", color: "red" }],
]);

const SEED_PROMO_CODES: PromoCodeRow[] = [
  {
    id: "dummy-summer25",
    codename: "SUMMER25",
    status: "active",
    statusDetail: null,
    discountKind: "percent",
    discountAmount: 25,
    productsLabel: "Pro Plan, Seats",
    numRedemptions: 236,
    maxRedemptions: 400,
    availability: "Jun 1 – Aug 31st Yearly",
    hasActiveSubscriptionRedemptions: true,
  },
  {
    id: "dummy-welcome10",
    codename: "WELCOME10",
    status: "scheduled",
    statusDetail: "Starts Sep 1st",
    discountKind: "fixed",
    discountAmount: 10,
    productsLabel: "Growth Plan",
    numRedemptions: 12,
    maxRedemptions: 100,
    availability: "Always",
    hasActiveSubscriptionRedemptions: false,
  },
  {
    id: "dummy-team-pause",
    codename: "TEAM50",
    status: "paused",
    statusDetail: "Since Aug 14th",
    discountKind: "percent",
    discountAmount: 50,
    productsLabel: "Team Plan",
    numRedemptions: 83,
    maxRedemptions: null,
    availability: "Always",
    hasActiveSubscriptionRedemptions: true,
  },
  {
    id: "dummy-expired",
    codename: "NY2026",
    status: "expired",
    statusDetail: "Since Jan 10th",
    discountKind: "percent",
    discountAmount: 15,
    productsLabel: "Pro Plan",
    numRedemptions: 400,
    maxRedemptions: 400,
    availability: "Jan 1st – Jan 10th 2026",
    hasActiveSubscriptionRedemptions: false,
  },
  {
    id: "dummy-ended",
    codename: "LAUNCH",
    status: "ended",
    statusDetail: "Since Feb 10th",
    discountKind: "fixed",
    discountAmount: 20,
    productsLabel: "All products",
    numRedemptions: 51,
    maxRedemptions: null,
    availability: "Always",
    hasActiveSubscriptionRedemptions: false,
  },
];

// TODO: Replace this dummy list with PromoCode rows from the API once the
// PromoCode table (and list endpoint) is wired. Status must be derived from
// PromoCode fields plus current time / redemptions — do not persist a
// separate status column.
export const DUMMY_PROMO_CODES: PromoCodeRow[] = [
  ...SEED_PROMO_CODES,
  ...Array.from({ length: 40 }, (_, index) => {
    const source = SEED_PROMO_CODES[index % SEED_PROMO_CODES.length] ?? throwErr("Missing seed promo code");
    const n = index + 2;
    return {
      ...source,
      id: `${source.id}-dup-${index}`,
      codename: `${source.codename}-${n}`,
      numRedemptions: source.numRedemptions + index,
    };
  }),
];

function parseStatusFilter(value: string): StatusFilter {
  if (value === "all" || value === "active" || value === "scheduled" || value === "paused" || value === "expired" || value === "ended") {
    return value;
  }
  throwErr(`Unknown status filter: ${value}`);
}

function parseSubscriptionDiscountEndChoice(value: string): SubscriptionDiscountEndChoice {
  if (value === "keep" || value === "end_after_period") return value;
  throwErr(`Unknown subscription discount end choice: ${value}`);
}

function getStatusBadge(status: PromoCodeStatus) {
  return STATUS_BADGE.get(status) ?? throwErr(`Missing status badge for "${status}"`);
}

export function formatDiscountLabel(kind: DiscountKind, amount: number): string {
  return kind === "percent" ? `${amount}% off` : `$${amount} off`;
}

function formatRedemptions(numRedemptions: number, maxRedemptions: number | null): string {
  if (maxRedemptions == null) return String(numRedemptions);
  return `${numRedemptions}/${maxRedemptions}`;
}

function canPause(status: PromoCodeStatus): boolean {
  return status !== "ended" && status !== "expired";
}

function canEnd(status: PromoCodeStatus): boolean {
  return status !== "ended";
}

export function PromoCodesListView(props: {
  promoCodes: PromoCodeRow[],
  onPromoCodesChange: (next: PromoCodeRow[]) => void,
  onCreate: () => void,
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [endingCode, setEndingCode] = useState<PromoCodeRow | null>(null);

  const handlePauseOrResume = useCallback((row: PromoCodeRow) => {
    props.onPromoCodesChange(props.promoCodes.map((current) => {
      if (current.id !== row.id) return current;
      if (current.status === "paused") {
        return { ...current, status: "active", statusDetail: null };
      }
      return { ...current, status: "paused", statusDetail: "Since just now" };
    }));
  }, [props]);

  const handleEnded = useCallback((rowId: string) => {
    props.onPromoCodesChange(props.promoCodes.map((current) => {
      if (current.id !== rowId) return current;
      return {
        ...current,
        status: "ended",
        statusDetail: "Since just now",
        hasActiveSubscriptionRedemptions: false,
      };
    }));
  }, [props]);

  const columns = useMemo<DataGridColumnDef<PromoCodeRow>[]>(() => [
    {
      id: "codename",
      header: "Codename",
      accessor: "codename",
      type: "string",
      width: 140,
      renderCell: ({ row }) => (
        <span className="truncate font-medium">{row.codename}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: "status",
      type: "string",
      width: 200,
      renderCell: ({ row }) => {
        const badge = getStatusBadge(row.status);
        return (
          <div className="flex min-w-0 items-center gap-2">
            <DesignBadge label={badge.label} color={badge.color} size="sm" />
            {row.statusDetail != null && (
              <span className="truncate text-xs text-muted-foreground">{row.statusDetail}</span>
            )}
          </div>
        );
      },
    },
    {
      id: "discount",
      header: "Discount",
      accessor: (row) => formatDiscountLabel(row.discountKind, row.discountAmount),
      type: "string",
      width: 110,
    },
    {
      id: "products",
      header: "Products",
      accessor: "productsLabel",
      type: "string",
      width: 180,
      flex: 1,
    },
    {
      id: "redemptions",
      header: "Redemptions",
      accessor: (row) => formatRedemptions(row.numRedemptions, row.maxRedemptions),
      type: "string",
      width: 120,
    },
    {
      id: "availability",
      header: "Availability",
      accessor: "availability",
      type: "string",
      width: 200,
      flex: 1,
    },
    {
      id: "actions",
      header: "",
      accessor: "id",
      type: "custom",
      width: 50,
      minWidth: 50,
      maxWidth: 50,
      sortable: false,
      hideable: false,
      resizable: false,
      renderCell: ({ row }) => (
        <div
          className="flex justify-end"
          data-no-row-click
          onClick={(event) => event.stopPropagation()}
        >
          <ActionCell
            items={[
              {
                item: "View details",
                onClick: () => {
                  // Dummy until the details surface is built.
                },
              },
              ...(canPause(row.status) ? [{
                item: row.status === "paused" ? "Resume" : "Pause",
                onClick: () => handlePauseOrResume(row),
              }] : []),
              "-",
              ...(canEnd(row.status) ? [{
                item: "End",
                danger: true,
                onClick: () => setEndingCode(row),
              }] : []),
            ]}
          />
        </div>
      ),
    },
  ], [handlePauseOrResume]);

  const [gridState, setGridState] = useDataGridUrlState(columns, { paramPrefix: "promocodes" });

  const dataSource = useMemo<DataGridDataSource<PromoCodeRow>>(
    () => async function* (params) {
      const query = typeof params.quickSearch === "string" ? params.quickSearch.trim().toLowerCase() : "";
      const offsetRaw = typeof params.cursor === "string" ? Number(params.cursor) : 0;
      const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
      const matched = props.promoCodes.filter((row) => {
        if (statusFilter !== "all" && row.status !== statusFilter) return false;
        if (query.length > 0 && !row.codename.toLowerCase().includes(query)) return false;
        return true;
      });
      const rows = matched.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + rows.length;
      yield {
        rows,
        hasMore: nextOffset < matched.length,
        nextCursor: nextOffset < matched.length ? String(nextOffset) : undefined,
      };
    },
    [props.promoCodes, statusFilter],
  );

  const getRowId = useCallback((row: PromoCodeRow) => row.id, []);
  const gridData = useDataSource({
    dataSource,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  return (
    <PageLayout
      title="Promo Codes"
      description="Codes customers can apply at checkout to discount their purchases."
      actions={(
        <DesignButton className="gap-1.5" onClick={props.onCreate}>
          <PlusIcon className="h-4 w-4" weight="bold" />
          Create a Promo Code
        </DesignButton>
      )}
    >
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
        fillHeight={false}
        footer={false}
        toolbarExtra={
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(parseStatusFilter(value))}>
            <SelectTrigger className="w-[160px] h-8 text-xs" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="ended">Ended</SelectItem>
            </SelectContent>
          </Select>
        }
        emptyState={
          <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <MagnifyingGlassIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="text-base font-medium text-foreground">No promo codes found</div>
            <p className="text-sm text-muted-foreground">
              Try adjusting your search or filter.
            </p>
          </div>
        }
      />

      <EndPromoCodeDialog
        promoCode={endingCode}
        onOpenChange={(open) => {
          if (!open) setEndingCode(null);
        }}
        onEnded={handleEnded}
      />
    </PageLayout>
  );
}

function EndPromoCodeDialog(props: {
  promoCode: PromoCodeRow | null,
  onOpenChange: (open: boolean) => void,
  onEnded: (rowId: string) => void,
}) {
  const promoCode = props.promoCode;
  const [subscriptionChoice, setSubscriptionChoice] = useState<SubscriptionDiscountEndChoice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const showSubscriptionChoice = promoCode?.hasActiveSubscriptionRedemptions === true;
  const canSubmit = promoCode != null && (!showSubscriptionChoice || subscriptionChoice != null);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setSubscriptionChoice(null);
      setErrorMessage(null);
    }
    props.onOpenChange(open);
  };

  const handleEnd = async () => {
    if (promoCode == null) {
      throwErr("End was submitted without a promo code");
    }
    if (showSubscriptionChoice && subscriptionChoice == null) {
      return "prevent-close" as const;
    }
    setErrorMessage(null);
    // Dummy commit until the end-promo API exists.
    // TODO: Call the end-promo API here (including subscriptionChoice when
    // live subscription redemptions exist). On failure, setErrorMessage and
    // keep the modal open — do not toast.
    await wait(400);
    props.onEnded(promoCode.id);
  };

  return (
    <ActionDialog
      open={promoCode != null}
      onOpenChange={handleOpenChange}
      title="End promo code?"
      danger
      size="md"
      cancelButton={{ label: "Back" }}
      okButton={{
        label: "End",
        onClick: handleEnd,
        props: { disabled: !canSubmit },
      }}
      description={promoCode == null
        ? undefined
        : `Ending ${promoCode.codename} means no one will be able to redeem this promo code again. Previous purchases will not be affected.`}
    >
      {showSubscriptionChoice && (
        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">What should happen to existing subscription discounts?</p>
            <p className="text-sm text-muted-foreground">
              Some subscriptions may currently receive this discount on every renewal.
            </p>
          </div>
          <RadioGroup
            value={subscriptionChoice ?? undefined}
            onValueChange={(value) => setSubscriptionChoice(parseSubscriptionDiscountEndChoice(value))}
            className="gap-3"
          >
            <SubscriptionEndOption
              value="keep"
              title="Keep their discount"
              description="Existing subscriptions will continue receiving the discount on future renewals. Only new redemptions will be prevented."
            />
            <SubscriptionEndOption
              value="end_after_period"
              title="End their discount after the current billing period"
              description="Existing subscriptions will return to their regular price on their next renewal."
            />
          </RadioGroup>
        </div>
      )}
      {errorMessage != null && (
        <DesignAlert variant="error" description={errorMessage} />
      )}
    </ActionDialog>
  );
}

function SubscriptionEndOption(props: {
  value: SubscriptionDiscountEndChoice,
  title: string,
  description: string,
}) {
  const optionId = `end-promo-subscription-${props.value}`;
  return (
    <label htmlFor={optionId} className="flex cursor-pointer items-start gap-3">
      <RadioGroupItem id={optionId} value={props.value} className="mt-1" />
      <span className="min-w-0 space-y-0.5">
        <Label htmlFor={optionId} className="cursor-pointer text-sm font-medium text-foreground">
          {props.title}
        </Label>
        <span className="block text-sm text-muted-foreground">{props.description}</span>
      </span>
    </label>
  );
}
