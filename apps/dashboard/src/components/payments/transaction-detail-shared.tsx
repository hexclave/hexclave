"use client";

import { DesignButton } from "@/components/design-components";
import { CopyableText } from "@/components/copyable-text";
import { useRouter } from "@/components/router";
import type { Transaction } from "@hexclave/shared/dist/interface/crud/transactions";
import type { ReactNode } from "react";
import { CustomerCell } from "./customer-cell";
import { describeTransactionEntry, describeTransactionEntryFields, getRelatedSubscriptionId, parseRefundSourceTxnId } from "./transaction-actions";

export const TRANSACTION_DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Dialog links wrapped in DesignButton-asChild don't navigate (the button
 * onClick swallows the default). Pushing from an async button click is the
 * reliable path inside a dialog and on the detail pages.
 */
export function PaymentsPageButton(props: {
  href: string,
  children: ReactNode,
  variant?: "secondary" | "ghost",
  className?: string,
}) {
  const router = useRouter();
  return (
    <DesignButton
      variant={props.variant ?? "secondary"}
      size="sm"
      type="button"
      className={props.className}
      onClick={async () => {
        router.push(props.href);
      }}
    >
      {props.children}
    </DesignButton>
  );
}

export function TransactionDetailRow(props: { label: string, children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <div className="shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">{props.label}</div>
      <div className="min-w-0 text-right text-sm text-foreground">{props.children}</div>
    </div>
  );
}

export function TransactionMonoId(props: { value: string }) {
  return <code className="break-all font-mono text-xs text-foreground/80">{props.value}</code>;
}

export function TransactionIdentityFields(props: {
  transaction: Transaction,
  copyableId?: boolean,
  linkCustomer?: boolean,
}) {
  return (
    <>
      <TransactionDetailRow label="Customer">
        <div className="flex justify-end">
          <CustomerCell
            customerType={props.transaction.customer_type}
            customerId={props.transaction.customer_id}
            link={props.linkCustomer !== false}
          />
        </div>
      </TransactionDetailRow>
      <TransactionDetailRow label="Created">
        {TRANSACTION_DATE_TIME_FORMAT.format(new Date(props.transaction.created_at_millis))}
      </TransactionDetailRow>
      <TransactionDetailRow label="Transaction ID">
        {props.copyableId
          ? (
            <div className="flex justify-end">
              <CopyableText value={props.transaction.id} />
            </div>
          )
          : <TransactionMonoId value={props.transaction.id} />}
      </TransactionDetailRow>
    </>
  );
}

export function TransactionLedgerFields(props: { transaction: Transaction }) {
  const refundSource = parseRefundSourceTxnId(props.transaction.id);
  const subscriptionId = getRelatedSubscriptionId(props.transaction);
  // Origin purchases already show this id as the transaction id. Renewals
  // already show it as "Renewal of". Don't repeat it as a fourth identity row.
  const distinctSubscriptionId = subscriptionId == null
    || subscriptionId === props.transaction.id
    || subscriptionId === props.transaction.renewal_target_subscription_id
    ? null
    : subscriptionId;
  return (
    <>
      {props.transaction.effective_at_millis !== props.transaction.created_at_millis ? (
        <TransactionDetailRow label="Effective">
          {TRANSACTION_DATE_TIME_FORMAT.format(new Date(props.transaction.effective_at_millis))}
        </TransactionDetailRow>
      ) : null}
      <TransactionDetailRow label="Type">
        {props.transaction.type ?? "—"}
      </TransactionDetailRow>
      {distinctSubscriptionId != null ? (
        <TransactionDetailRow label="Subscription">
          <div className="flex justify-end">
            <CopyableText value={distinctSubscriptionId} />
          </div>
        </TransactionDetailRow>
      ) : null}
      {props.transaction.renewal_target_subscription_id != null ? (
        <TransactionDetailRow label="Renewal of">
          <div className="flex justify-end">
            <CopyableText value={props.transaction.renewal_target_subscription_id} />
          </div>
        </TransactionDetailRow>
      ) : null}
      {refundSource != null ? (
        <TransactionDetailRow label="Refund of">
          <div className="flex justify-end">
            <CopyableText value={refundSource} />
          </div>
        </TransactionDetailRow>
      ) : null}
    </>
  );
}

export function TransactionLineItems(props: { transaction: Transaction, detailed?: boolean }) {
  if (props.transaction.entries.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Line items</div>
      <ul className="flex flex-col overflow-hidden rounded-xl ring-1 ring-foreground/[0.06]">
        {props.transaction.entries.map((entry, index) => {
          const described = describeTransactionEntry(entry);
          const fields = props.detailed === true ? describeTransactionEntryFields(entry) : [];
          return (
            <li key={index} className="flex flex-col gap-1.5 px-3 py-2.5 even:bg-foreground/[0.02]">
              <div className="flex items-start justify-between gap-4">
                <div className="text-sm font-medium text-foreground">{described.label}</div>
                {fields.length === 0 ? (
                  <div className="min-w-0 break-all text-right text-xs text-muted-foreground">{described.detail}</div>
                ) : null}
              </div>
              {fields.map((field) => (
                <div key={field.label} className="flex items-start justify-between gap-4">
                  <div className="text-xs text-muted-foreground">{field.label}</div>
                  <div className="min-w-0 break-all text-right font-mono text-xs text-foreground/80">{field.value}</div>
                </div>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
