"use client";

import { PageLayout } from "@/app/(main)/(protected)/projects/[projectId]/page-layout";
import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { DesignAlert, DesignBadge, DesignButton, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { useRouter } from "@/components/router";
import { Skeleton } from "@/components/ui";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import type { Transaction } from "@hexclave/shared/dist/interface/crud/transactions";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { RefundOrCancelDialog } from "./refund-or-cancel-dialog";
import { RelatedTransactionsSection } from "./related-transactions";
import {
  PaymentsPageButton,
  TransactionIdentityFields,
  TransactionLedgerFields,
  TransactionLineItems,
} from "./transaction-detail-shared";
import {
  getAccessAlreadyEnded,
  getMoneyAlreadyReturned,
  getTransactionRowActions,
  getTransactionSummary,
  isLifecycleRowAction,
  isPaymentRowAction,
  parseCustomerTypeParam,
  TRANSACTION_ROW_ACTION_LABELS,
  type TransactionRowActionKind,
} from "./transaction-actions";
import { TransactionAmountCell } from "./transaction-table-cells";

const CUSTOMER_HISTORY_LIMIT = 1000;

export function PaymentsDetailBackLink(props: { href: string, label: string }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-2">
      <DesignButton
        variant="ghost"
        size="sm"
        className="w-fit -ml-2 h-8 gap-1.5 rounded-lg px-2 text-muted-foreground transition-colors hover:text-foreground hover:transition-none"
        onClick={() => router.back()}
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back
      </DesignButton>
      <Link href={props.href} className="text-xs text-muted-foreground hover:text-foreground hover:transition-none">
        {props.label}
      </Link>
    </div>
  );
}

export function CustomerHistoryProvider(props: {
  customerType: Transaction["customer_type"],
  customerId: string,
  children: (args: { transactions: Transaction[], truncated: boolean }) => ReactNode,
}) {
  const app = useAdminApp();
  const { transactions, nextCursor } = app.useTransactions({
    limit: CUSTOMER_HISTORY_LIMIT,
    customerType: props.customerType,
    customerId: props.customerId,
  });
  return <>{props.children({ transactions, truncated: nextCursor != null })}</>;
}

export function usePaymentsCustomerQuery(): {
  customerType: Transaction["customer_type"],
  customerId: string,
} | null {
  const searchParams = useSearchParams();
  const customerType = parseCustomerTypeParam(searchParams.get("customer_type"));
  const customerId = searchParams.get("customer_id");
  if (customerType == null || customerId == null || customerId === "") {
    return null;
  }
  return { customerType, customerId };
}

function actionLabel(kind: TransactionRowActionKind): string {
  return TRANSACTION_ROW_ACTION_LABELS.get(kind) ?? throwErr("Missing label for transaction row action", { kind });
}

export function TransactionDetailView(props: { transaction: Transaction, knownTransactions: readonly Transaction[] }) {
  const summary = getTransactionSummary(props.transaction);
  const actions = getTransactionRowActions(props.transaction);
  const paymentAction = actions.find(isPaymentRowAction);
  const lifecycleAction = actions.find(isLifecycleRowAction);
  const [actionKind, setActionKind] = useState<TransactionRowActionKind | null>(null);

  const activeAction = actionKind == null
    ? null
    : actions.find((action) => action.kind === actionKind) ?? throwErr("Requested transaction action is not listed", { kind: actionKind });
  if (activeAction != null && !activeAction.available) {
    throwErr("Requested transaction action is unavailable", { kind: actionKind, reason: activeAction.reason });
  }

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15">
              <summary.displayType.Icon className="h-4 w-4 text-primary" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">{summary.displayType.label}</h2>
              {summary.detail !== "—" && summary.detail !== summary.displayType.label ? (
                <div className="mt-0.5 text-sm text-muted-foreground">{summary.detail}</div>
              ) : null}
            </div>
          </div>
          <DesignCard>
            <div className="flex items-center justify-between gap-3">
              <TransactionAmountCell summary={summary} size="md" />
              {summary.status != null ? (
                <DesignBadge label={summary.status.label} color={summary.status.color} size="sm" />
              ) : null}
            </div>
            <div className="mt-4 flex flex-col divide-y divide-foreground/[0.06]">
              <TransactionIdentityFields transaction={props.transaction} copyableId />
              {props.transaction.test_mode ? (
                <div className="flex items-start justify-between gap-6 py-2">
                  <div className="shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">Mode</div>
                  <DesignBadge label="Test" color="orange" size="sm" />
                </div>
              ) : null}
              <TransactionLedgerFields transaction={props.transaction} />
            </div>
          </DesignCard>
          <div className="flex flex-wrap items-center gap-2">
            {lifecycleAction?.available === true ? (
              <DesignButton
                variant="destructive"
                size="sm"
                type="button"
                onClick={() => setActionKind(lifecycleAction.kind)}
              >
                {actionLabel(lifecycleAction.kind)}
              </DesignButton>
            ) : null}
            {paymentAction != null ? (
              <DesignButton
                variant="default"
                size="sm"
                type="button"
                disabled={!paymentAction.available}
                onClick={() => {
                  if (!paymentAction.available) {
                    throwErr("Unavailable refund was clicked from transaction page");
                  }
                  setActionKind("refund");
                }}
              >
                {actionLabel("refund")}
              </DesignButton>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <TransactionLineItems transaction={props.transaction} detailed />
          <RelatedTransactionsSection
            transaction={props.transaction}
            knownTransactions={props.knownTransactions}
            linkToPages
          />
        </div>
      </div>
      {activeAction?.available === true ? (
        <RefundOrCancelDialog
          onClose={() => setActionKind(null)}
          intent={activeAction.kind}
          target={activeAction.target}
          productDisplayName={summary.productDisplayName}
          chargedAmountUsd={summary.chargedAmountUsd}
          moneyAlreadyReturned={getMoneyAlreadyReturned(props.transaction)}
          accessAlreadyEnded={getAccessAlreadyEnded(props.transaction)}
        />
      ) : null}
    </>
  );
}

export function TransactionDetailMissing(props: {
  transactionId: string,
  truncated: boolean,
}) {
  const app = useAdminApp();
  return (
    <PageLayout title="Transaction">
      <DesignAlert
        variant="error"
        description={props.truncated
          ? `Transaction ${props.transactionId} isn’t in this customer’s most recent ${CUSTOMER_HISTORY_LIMIT.toLocaleString()} transactions.`
          : "This transaction wasn’t found in the customer’s loaded history."}
      />
      <PaymentsPageButton href={urlString`/projects/${app.projectId}/payments/transactions`}>
        Back to transactions
      </PaymentsPageButton>
    </PageLayout>
  );
}

export function PaymentsDetailLoading() {
  return (
    <PageLayout>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    </PageLayout>
  );
}

export function PaymentsCustomerQueryMissing(props: { title: string }) {
  const app = useAdminApp();
  return (
    <PageLayout title={props.title}>
      <DesignAlert
        variant="error"
        description="This page needs a customer to load history. Open it from a transaction in the dashboard."
      />
      <PaymentsPageButton href={urlString`/projects/${app.projectId}/payments/transactions`}>
        Back to transactions
      </PaymentsPageButton>
    </PageLayout>
  );
}
