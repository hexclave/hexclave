"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { DesignAlert } from "@/components/design-components";
import { Link } from "@/components/link";
import { Skeleton } from "@/components/ui";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { Transaction } from "@hexclave/shared/dist/interface/crud/transactions";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { Suspense, useEffect, useMemo } from "react";
import {
  collectRelatedTransactions,
  getRelatedTransactionRefs,
  getTransactionFamilyId,
  getTransactionSummary,
  transactionPageHref,
  type RelatedTransactionMatch,
  type RelatedTransactionRef,
} from "./transaction-actions";
import { TransactionAmountCell } from "./transaction-table-cells";

const RELATED_HISTORY_LIMIT = 1000;
const RELATED_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * Refunds/cancels point at the charge they adjusted; renewals point at the
 * original purchase. Sibling renewals of the same subscription are joined
 * from this customer's history so a renewal isn't an orphan invoice.
 */
export function RelatedTransactionsSection(props: {
  transaction: Transaction,
  knownTransactions: readonly Transaction[],
  onOpenTransaction?: (transaction: Transaction) => void,
  linkToPages?: boolean,
}) {
  const refs = getRelatedTransactionRefs(props.transaction);
  if (refs.length === 0 && getTransactionFamilyId(props.transaction) == null) {
    return null;
  }

  return (
    <ErrorBoundary errorComponent={RelatedTransactionsError}>
      <Suspense fallback={<RelatedTransactionsSkeleton />}>
        <RelatedTransactionsBody
          transaction={props.transaction}
          knownTransactions={props.knownTransactions}
          onOpenTransaction={props.onOpenTransaction}
          linkToPages={props.linkToPages === true}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

function RelatedTransactionsError(props: { error: unknown }) {
  useEffect(() => {
    captureError("transaction-details-related-transactions", props.error instanceof Error ? props.error : new Error(String(props.error)));
  }, [props.error]);
  return (
    <DesignAlert
      variant="error"
      description="Couldn’t load related transactions for this customer."
    />
  );
}

function RelatedTransactionsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Related transactions</div>
      <Skeleton className="h-14 rounded-xl" />
      <Skeleton className="h-14 rounded-xl" />
    </div>
  );
}

function RelatedTransactionsBody(props: {
  transaction: Transaction,
  knownTransactions: readonly Transaction[],
  onOpenTransaction?: (transaction: Transaction) => void,
  linkToPages: boolean,
}) {
  const knownById = useMemo(
    () => new Map(props.knownTransactions.map((transaction) => [transaction.id, transaction])),
    [props.knownTransactions],
  );
  const refs = getRelatedTransactionRefs(props.transaction);
  const needsCustomerHistory = getTransactionFamilyId(props.transaction) != null
    || refs.some((ref) => !knownById.has(ref.listedId));

  if (!needsCustomerHistory) {
    return (
      <RelatedTransactionsList
        current={props.transaction}
        pool={knownById}
        historyTruncated={false}
        onOpenTransaction={props.onOpenTransaction}
        linkToPages={props.linkToPages}
      />
    );
  }

  return (
    <RelatedTransactionsFromCustomer
      transaction={props.transaction}
      knownById={knownById}
      onOpenTransaction={props.onOpenTransaction}
      linkToPages={props.linkToPages}
    />
  );
}

function RelatedTransactionsFromCustomer(props: {
  transaction: Transaction,
  knownById: ReadonlyMap<string, Transaction>,
  onOpenTransaction?: (transaction: Transaction) => void,
  linkToPages: boolean,
}) {
  const app = useAdminApp();
  const { transactions, nextCursor } = app.useTransactions({
    limit: RELATED_HISTORY_LIMIT,
    customerType: props.transaction.customer_type,
    customerId: props.transaction.customer_id,
  });
  const pool = useMemo(() => {
    const merged = new Map(props.knownById);
    for (const transaction of transactions) {
      merged.set(transaction.id, transaction);
    }
    return merged;
  }, [props.knownById, transactions]);

  return (
    <RelatedTransactionsList
      current={props.transaction}
      pool={pool}
      historyTruncated={nextCursor != null}
      onOpenTransaction={props.onOpenTransaction}
      linkToPages={props.linkToPages}
    />
  );
}

function RelatedTransactionsList(props: {
  current: Transaction,
  pool: ReadonlyMap<string, Transaction>,
  historyTruncated: boolean,
  onOpenTransaction?: (transaction: Transaction) => void,
  linkToPages: boolean,
}) {
  const { matches, unresolved } = collectRelatedTransactions(props.current, props.pool);
  if (matches.length === 0 && unresolved.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Related transactions</div>
      <div className="flex flex-col overflow-hidden rounded-xl ring-1 ring-foreground/[0.06]">
        {matches.map((match) => (
          <RelatedTransactionRow
            key={match.transaction.id}
            match={match}
            linkToPages={props.linkToPages}
            onOpen={props.onOpenTransaction == null ? undefined : () => props.onOpenTransaction?.(match.transaction)}
          />
        ))}
        {unresolved.map((ref) => (
          <UnresolvedRelatedRow
            key={`${ref.relation}:${ref.listedId}`}
            refLink={ref}
            historyTruncated={props.historyTruncated}
            current={props.current}
            linkToPages={props.linkToPages}
          />
        ))}
      </div>
    </div>
  );
}

function RelatedTransactionRow(props: {
  match: RelatedTransactionMatch,
  onOpen?: () => void,
  linkToPages: boolean,
}) {
  const app = useAdminApp();
  const summary = getTransactionSummary(props.match.transaction);
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">{props.match.label}</div>
        <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{summary.displayType.label}</span>
          <span className="truncate text-xs text-muted-foreground">
            {RELATED_DATE_FORMAT.format(new Date(props.match.transaction.created_at_millis))}
          </span>
        </div>
      </div>
      <TransactionAmountCell summary={summary} size="sm" />
      <CaretRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </>
  );
  const className = "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] hover:transition-none";
  if (props.linkToPages) {
    return (
      <Link href={transactionPageHref(app.projectId, props.match.transaction)} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className={className}
    >
      {inner}
    </button>
  );
}

function UnresolvedRelatedRow(props: {
  refLink: RelatedTransactionRef,
  historyTruncated: boolean,
  current: Transaction,
  linkToPages: boolean,
}) {
  const app = useAdminApp();
  const label = props.refLink.relation === "original" ? "Original payment" : "Related transaction";
  const reason = props.historyTruncated
    ? `Not in this customer’s most recent ${RELATED_HISTORY_LIMIT.toLocaleString()} transactions.`
    : "This transaction isn’t in the loaded history.";
  const href = transactionPageHref(app.projectId, {
    id: props.refLink.listedId,
    customer_type: props.current.customer_type,
    customer_id: props.current.customer_id,
  });
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {props.linkToPages ? (
        <Link href={href} className="break-all font-mono text-xs text-foreground/80 hover:text-foreground hover:transition-none">
          {props.refLink.listedId}
        </Link>
      ) : (
        <code className="break-all font-mono text-xs text-foreground/80">{props.refLink.listedId}</code>
      )}
      <div className="text-xs text-muted-foreground">{reason}</div>
    </div>
  );
}
