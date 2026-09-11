"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import {
  DesignBadge,
  DesignButton,
  DesignDialog,
  DesignDialogClose,
} from "@/components/design-components";
import { ActionCell, SimpleTooltip } from "@/components/ui";
import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import type { Transaction } from "@hexclave/shared/dist/interface/crud/transactions";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { RefundOrCancelDialog } from "./refund-or-cancel-dialog";
import { PaymentsPageButton, TransactionIdentityFields } from "./transaction-detail-shared";
import {
  getAccessAlreadyEnded,
  getMoneyAlreadyReturned,
  getTransactionRowActions,
  getTransactionSummary,
  isLifecycleRowAction,
  isPaymentRowAction,
  TRANSACTION_ROW_ACTION_LABELS,
  transactionPageHref,
  type TransactionRowAction,
  type TransactionRowActionKind,
} from "./transaction-actions";
import { TransactionAmountCell } from "./transaction-table-cells";

/**
 * Standard interaction model for every transaction table in the dashboard
 * (project-wide transactions page, and the per-customer "Transaction history"
 * section):
 *
 * - Clicking a row is a *view* action and opens a glanceable details dialog
 *   (identity + one Open to this transaction’s page). Related charges live
 *   on that page — the dialog itself must never scroll. A subscription’s
 *   original purchase *is* the subscription; there is no second page type.
 * - Mutations split like a Stripe payment page: Refund is the action on
 *   *this charge*; Cancel / Revoke live on the related subscription or
 *   grant. Both still come from `getTransactionRowActions`, so availability
 *   never disagrees across the kebab, the details footer, and the pages.
 *   Combined refund+cancel is an opt-in on those forms, not a third peer action.
 *
 * `useTransactionDialog` owns the dialog state for a table; callers spread its
 * `onRowClick`, append `actionsColumn` to their columns, and render `dialog`.
 */

export type TransactionDialogView = "details" | TransactionRowActionKind;

export type TransactionDialogRequest = {
  transaction: Transaction,
  view: TransactionDialogView,
  /** Set when an action view was entered from the details view, so "Back" returns there. */
  returnToDetails?: boolean,
};

type OpenTransactionDialog = (transaction: Transaction, view: TransactionDialogView) => void;

export function useTransactionDialog(options: { onCompleted?: () => void } = {}) {
  const [request, setRequest] = useState<TransactionDialogRequest | null>(null);
  const open = useCallback<OpenTransactionDialog>((transaction, view) => {
    setRequest({ transaction, view });
  }, []);
  const onRowClick = useCallback((row: Transaction) => {
    open(row, "details");
  }, [open]);
  const actionsColumn = useMemo(() => createTransactionActionsColumn(open), [open]);
  const dialog = request == null ? null : (
    <TransactionDialog
      key={request.transaction.id}
      request={request}
      onRequestChange={setRequest}
      onCompleted={options.onCompleted}
    />
  );
  return { open, onRowClick, actionsColumn, dialog };
}

function createTransactionActionsColumn(open: OpenTransactionDialog): DataGridColumnDef<Transaction> {
  return {
    id: "actions",
    header: "",
    width: 50,
    minWidth: 50,
    maxWidth: 50,
    align: "right",
    sortable: false,
    hideable: false,
    resizable: false,
    renderCell: ({ row }) => <TransactionRowActionsCell transaction={row} onOpen={open} />,
  };
}

function actionMenuLabel(kind: TransactionRowActionKind): string {
  const label = TRANSACTION_ROW_ACTION_LABELS.get(kind) ?? throwErr("Missing label for transaction row action", { kind });
  return `${label}…`;
}

function menuItemForAction(
  transaction: Transaction,
  action: TransactionRowAction,
  onOpen: OpenTransactionDialog,
) {
  return {
    item: actionMenuLabel(action.kind),
    danger: isLifecycleRowAction(action),
    disabled: !action.available,
    disabledTooltip: action.available ? undefined : action.reason,
    onClick: () => {
      if (!action.available) {
        // Disabled menu items don't fire, so this is only reachable if
        // the menu and the action model disagree.
        throwErr("Unavailable transaction action was clicked", { transactionId: transaction.id, kind: action.kind });
      }
      onOpen(transaction, action.kind);
    },
  };
}

function TransactionRowActionsCell(props: { transaction: Transaction, onOpen: OpenTransactionDialog }) {
  const actions = getTransactionRowActions(props.transaction);
  const paymentActions = actions.filter(isPaymentRowAction);
  // Already-canceled / already-revoked is obvious from the row status; don't
  // keep a disabled "Cancel subscription" in the menu. Refund stays, even
  // when disabled, so test-mode purchases still explain why money can't move.
  const lifecycleActions = actions.filter((action) => isLifecycleRowAction(action) && action.available);
  return (
    <ActionCell
      items={[
        { item: "View details", onClick: () => props.onOpen(props.transaction, "details") },
        ...paymentActions.map((action) => menuItemForAction(props.transaction, action, props.onOpen)),
        ...(lifecycleActions.length > 0 ? ["-" as const, ...lifecycleActions.map((action) => menuItemForAction(props.transaction, action, props.onOpen))] : []),
      ]}
    />
  );
}

function TransactionDialog(props: {
  request: TransactionDialogRequest,
  onRequestChange: (request: TransactionDialogRequest | null) => void,
  onCompleted?: () => void,
}) {
  const { transaction, view, returnToDetails } = props.request;
  const close = () => props.onRequestChange(null);

  if (view === "details") {
    return (
      <TransactionDetailsDialog
        transaction={transaction}
        onClose={close}
        onAction={(kind) => props.onRequestChange({ transaction, view: kind, returnToDetails: true })}
      />
    );
  }

  const summary = getTransactionSummary(transaction);
  // Both entry points (kebab menu, details footer) only offer *available*
  // actions, so reaching an unavailable one here means the UI and the action
  // model disagree — surface that instead of showing a broken form.
  const action = getTransactionRowActions(transaction).find((candidate) => candidate.kind === view)
    ?? throwErr("Requested transaction action is not listed for this transaction", { transactionId: transaction.id, view });
  if (!action.available) {
    throwErr("Requested transaction action is unavailable for this transaction", { transactionId: transaction.id, view, reason: action.reason });
  }

  return (
    <RefundOrCancelDialog
      key={view}
      onClose={close}
      onBack={returnToDetails ? () => props.onRequestChange({ transaction, view: "details" }) : undefined}
      intent={view}
      target={action.target}
      productDisplayName={summary.productDisplayName}
      chargedAmountUsd={summary.chargedAmountUsd}
      moneyAlreadyReturned={getMoneyAlreadyReturned(transaction)}
      accessAlreadyEnded={getAccessAlreadyEnded(transaction)}
      onCompleted={props.onCompleted}
    />
  );
}

function actionLabel(kind: TransactionRowActionKind): string {
  return TRANSACTION_ROW_ACTION_LABELS.get(kind) ?? throwErr("Missing label for transaction row action", { kind });
}

function RefundPaymentButton(props: {
  action: TransactionRowAction,
  onAction: (kind: TransactionRowActionKind) => void,
}) {
  const button = (
    <DesignButton
      variant="default"
      size="sm"
      type="button"
      disabled={!props.action.available}
      onClick={() => {
        if (!props.action.available) {
          throwErr("Unavailable refund was clicked from transaction details");
        }
        props.onAction("refund");
      }}
    >
      {actionLabel("refund")}
    </DesignButton>
  );
  if (props.action.available) {
    return button;
  }
  return <SimpleTooltip tooltip={props.action.reason}>{button}</SimpleTooltip>;
}

function TransactionDetailsDialog(props: {
  transaction: Transaction,
  onClose: () => void,
  onAction: (kind: TransactionRowActionKind) => void,
}) {
  const app = useAdminApp();
  const { transaction } = props;
  const summary = getTransactionSummary(transaction);
  const actions = getTransactionRowActions(transaction);
  const paymentAction = actions.find(isPaymentRowAction);
  const detailDescription = summary.detail !== "—" && summary.detail !== summary.displayType.label
    ? summary.detail
    : undefined;
  const transactionHref = transactionPageHref(app.projectId, transaction);

  return (
    <DesignDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      size="md"
      icon={summary.displayType.Icon}
      title={summary.displayType.label}
      description={detailDescription}
      headerContent={(
        <div className="flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.02] px-3 py-2.5 ring-1 ring-foreground/[0.06]">
          <TransactionAmountCell summary={summary} size="md" />
          {summary.status != null
            ? <DesignBadge label={summary.status.label} color={summary.status.color} size="sm" />
            : null}
        </div>
      )}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm" type="button">
              Close
            </DesignButton>
          </DesignDialogClose>
          <PaymentsPageButton href={transactionHref} className="gap-1.5">
            Open
            <ArrowSquareOutIcon className="h-3.5 w-3.5" />
          </PaymentsPageButton>
          {paymentAction != null ? (
            <RefundPaymentButton action={paymentAction} onAction={props.onAction} />
          ) : null}
        </div>
      )}
    >
      <div className="flex flex-col divide-y divide-foreground/[0.06]">
        <TransactionIdentityFields transaction={transaction} linkCustomer={false} />
      </div>
    </DesignDialog>
  );
}

/**
 * Cancel entry point for the customer's "Products & subscriptions" list, where
 * there is no transaction row to hang the action on — only a live subscription.
 */
export function SubscriptionCancelDialog(props: {
  onClose: () => void,
  subscriptionId: string,
  productDisplayName: string,
  onCompleted?: () => void,
}) {
  return (
    <RefundOrCancelDialog
      onClose={props.onClose}
      intent="cancel"
      target={{ type: "subscription", id: props.subscriptionId }}
      productDisplayName={props.productDisplayName}
      chargedAmountUsd={null}
      moneyAlreadyReturned={false}
      accessAlreadyEnded={false}
      onCompleted={props.onCompleted}
    />
  );
}
