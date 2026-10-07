"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import {
  DesignAlert,
  DesignBadge,
  type DesignBadgeColor,
  DesignButton,
  DesignDialog,
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
import type { AdminPromoCode } from "@hexclave/next";
import { KnownErrors } from "@hexclave/shared";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { PageLayout } from "../../page-layout";

export type PromoCodeStatus = "active" | "scheduled" | "paused" | "expired" | "ended";
export type DiscountKind = "percent" | "fixed";
export type SubscriptionDiscountEndChoice = "keep" | "end_after_period";
export type SubscriptionBehavior = "first_payment" | "fixed_duration" | "forever";

export type PromoCodeRow = {
  id: string,
  codename: string,
  status: PromoCodeStatus,
  statusDetail: string | null,
  discountKind: DiscountKind,
  discountAmount: number,
  discountLabel: string,
  productsLabel: string,
  applicableProductIds: string[] | null,
  numRedemptions: number,
  maxRedemptions: number | null,
  availability: string,
  availabilityType: "always" | "between_dates",
  startsAt: Date | null,
  endsAt: Date | null,
  pausedAt: Date | null,
  endedAt: Date | null,
  subscriptionBehavior: SubscriptionBehavior,
  subscriptionDiscountDurationMonths: number | null,
  hasActiveSubscriptionRedemptions: boolean,
};

type StatusFilter = "all" | PromoCodeStatus;

const STATUS_BADGE = new Map<PromoCodeStatus, { label: string, color: DesignBadgeColor }>([
  ["active", { label: "Active", color: "green" }],
  ["scheduled", { label: "Scheduled", color: "cyan" }],
  ["paused", { label: "Paused", color: "blue" }],
  ["expired", { label: "Expired", color: "red" }],
  ["ended", { label: "Ended", color: "red" }],
]);

export function adminPromoCodeToRow(promo: AdminPromoCode): PromoCodeRow {
  return {
    id: promo.id,
    codename: promo.codeName,
    status: promo.status,
    statusDetail: promo.statusDetail,
    discountKind: promo.discountType === "percent" ? "percent" : "fixed",
    discountAmount: promo.discountAmount,
    discountLabel: promo.discountLabel,
    productsLabel: promo.productsLabel,
    applicableProductIds: promo.applicableProductIds,
    numRedemptions: promo.numRedemptions,
    maxRedemptions: promo.maxRedemptions,
    availability: promo.availability,
    availabilityType: promo.availabilityType,
    startsAt: promo.startsAt,
    endsAt: promo.endsAt,
    pausedAt: promo.pausedAt,
    endedAt: promo.endedAt,
    subscriptionBehavior: promo.subscriptionBehavior,
    subscriptionDiscountDurationMonths: promo.subscriptionDiscountDurationMonths,
    hasActiveSubscriptionRedemptions: promo.hasActiveSubscriptionRedemptions,
  };
}

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

function promoErrorMessage(error: unknown): string {
  if (error instanceof KnownErrors.PromoCodeInvalid
    || error instanceof KnownErrors.PromoCodeCannotPause
    || error instanceof KnownErrors.PromoCodeCannotResume
    || error instanceof KnownErrors.PromoCodeAlreadyEnded
    || error instanceof KnownErrors.PromoCodeNotFound
    || error instanceof KnownErrors.PromoCodeCodeNameAlreadyExists
    || error instanceof KnownErrors.PromoCodeStripeCreateFailed
  ) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function subscriptionBehaviorLabel(row: PromoCodeRow): string {
  if (row.subscriptionBehavior === "first_payment") return "First payment only";
  if (row.subscriptionBehavior === "forever") return "On every renewal";
  const months = row.subscriptionDiscountDurationMonths ?? throwErr("fixed_duration promo is missing months");
  return `For ${months} month${months === 1 ? "" : "s"}`;
}

export function PromoCodesListView(props: {
  onCreate: () => void,
  refreshKey: number,
  onChanged: () => void,
}) {
  const adminApp = useAdminApp();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [endingCode, setEndingCode] = useState<PromoCodeRow | null>(null);
  const [detailsCode, setDetailsCode] = useState<PromoCodeRow | null>(null);

  const columns = useMemo<DataGridColumnDef<PromoCodeRow>[]>(() => [
    {
      id: "codename",
      header: "Codename",
      accessor: "codename",
      type: "string",
      width: 140,
      sortable: false,
      renderCell: ({ row }) => (
        <span className="truncate font-medium">{row.codename}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: "status",
      type: "string",
      width: 220,
      sortable: false,
      cellOverflow: "wrap",
      renderCell: ({ row }) => {
        const badge = getStatusBadge(row.status);
        return (
          <div className={row.statusDetail != null ? "flex min-w-0 flex-col gap-1 py-0.5" : "flex min-w-0 flex-col gap-0.5"}>
            <DesignBadge label={badge.label} color={badge.color} size="sm" />
            {row.statusDetail != null && (
              <span className="whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                {row.statusDetail}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: "discount",
      header: "Discount",
      accessor: (row) => row.discountLabel,
      type: "string",
      width: 110,
      sortable: false,
    },
    {
      id: "products",
      header: "Products",
      accessor: "productsLabel",
      type: "string",
      width: 180,
      flex: 1,
      sortable: false,
    },
    {
      id: "redemptions",
      header: "Redemptions",
      accessor: (row) => formatRedemptions(row.numRedemptions, row.maxRedemptions),
      type: "string",
      width: 120,
      sortable: false,
    },
    {
      id: "availability",
      header: "Availability",
      accessor: "availability",
      type: "string",
      width: 200,
      flex: 1,
      sortable: false,
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
                onClick: () => setDetailsCode(row),
              },
              ...(canPause(row.status) ? [{
                item: row.status === "paused" ? "Resume" : "Pause",
                onClick: () => runAsynchronouslyWithAlert(async () => {
                  if (row.status === "paused") {
                    await adminApp.resumePromoCode(row.id);
                  } else {
                    await adminApp.pausePromoCode(row.id);
                  }
                  props.onChanged();
                }),
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
  ], [adminApp, props]);

  const [gridState, setGridState] = useDataGridUrlState(columns, { paramPrefix: "promocodes" });

  const dataSource = useMemo<DataGridDataSource<PromoCodeRow>>(
    () => async function* (params) {
      void props.refreshKey;
      const query = typeof params.quickSearch === "string" ? params.quickSearch.trim() : "";
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const result = await adminApp.listPromoCodes({
        cursor,
        query: query.length > 0 ? query : undefined,
        status: statusFilter,
      });
      yield {
        rows: result.promoCodes.map(adminPromoCodeToRow),
        hasMore: result.nextCursor != null,
        nextCursor: result.nextCursor ?? undefined,
      };
    },
    [adminApp, statusFilter, props.refreshKey],
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
      {gridData.error != null && gridData.rows.length === 0 ? (
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-8">
          <DesignAlert
            variant="error"
            title="Couldn't load promo codes"
            description="Something went wrong while loading promo codes. Try again."
          />
          <DesignButton variant="outline" onClick={() => gridData.reload()}>
            Retry
          </DesignButton>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          {gridData.error != null && (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <DesignAlert
                variant="error"
                title="Couldn't load promo codes"
                description="Something went wrong while loading more promo codes. Try again."
              />
              <DesignButton variant="outline" onClick={() => gridData.reload()}>
                Retry
              </DesignButton>
            </div>
          )}
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
            rowHeight="auto"
            estimatedRowHeight={44}
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
        </div>
      )}

      <EndPromoCodeDialog
        promoCode={endingCode}
        onOpenChange={(open) => {
          if (!open) setEndingCode(null);
        }}
        onEnded={() => {
          setEndingCode(null);
          props.onChanged();
        }}
      />
      <PromoCodeDetailsDialog
        promoCode={detailsCode}
        onOpenChange={(open) => {
          if (!open) setDetailsCode(null);
        }}
      />
    </PageLayout>
  );
}

function PromoCodeDetailsDialog(props: {
  promoCode: PromoCodeRow | null,
  onOpenChange: (open: boolean) => void,
}) {
  const promoCode = props.promoCode;
  const badge = promoCode != null ? getStatusBadge(promoCode.status) : null;
  return (
    <DesignDialog
      open={promoCode != null}
      onOpenChange={props.onOpenChange}
      size="md"
      title={promoCode?.codename ?? "Promo code"}
    >
      {promoCode != null && badge != null && (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <DesignBadge label={badge.label} color={badge.color} size="sm" />
            {promoCode.statusDetail != null && (
              <span className="text-muted-foreground">{promoCode.statusDetail}</span>
            )}
          </div>
          <DetailRow label="Discount" value={promoCode.discountLabel} />
          <DetailRow label="Products" value={promoCode.productsLabel} />
          <DetailRow label="Redemptions" value={formatRedemptions(promoCode.numRedemptions, promoCode.maxRedemptions)} />
          <DetailRow label="Availability" value={promoCode.availability} />
          <DetailRow label="Subscription discount" value={subscriptionBehaviorLabel(promoCode)} />
        </div>
      )}
    </DesignDialog>
  );
}

function DetailRow(props: { label: string, value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{props.label}</span>
      <span className="text-foreground">{props.value}</span>
    </div>
  );
}

function EndPromoCodeDialog(props: {
  promoCode: PromoCodeRow | null,
  onOpenChange: (open: boolean) => void,
  onEnded: () => void,
}) {
  const adminApp = useAdminApp();
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
    try {
      await adminApp.endPromoCode(promoCode.id, {
        existingSubscriptionDiscounts: showSubscriptionChoice
          ? (subscriptionChoice ?? throwErr("End requires a subscription discount choice"))
          : undefined,
      });
    } catch (error) {
      setErrorMessage(promoErrorMessage(error));
      return "prevent-close" as const;
    }
    props.onEnded();
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
