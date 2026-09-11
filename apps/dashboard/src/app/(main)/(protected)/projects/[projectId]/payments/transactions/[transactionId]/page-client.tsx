"use client";

import { PageLayout } from "../../../page-layout";
import { useProjectId } from "../../../use-admin-app";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import {
  CustomerHistoryProvider,
  PaymentsCustomerQueryMissing,
  PaymentsDetailBackLink,
  PaymentsDetailLoading,
  TransactionDetailMissing,
  TransactionDetailView,
  usePaymentsCustomerQuery,
} from "@/components/payments/transaction-detail-page";
import { parsePaymentsEntityPath } from "@/components/payments/transaction-actions";

export default function PageClient() {
  return (
    <Suspense fallback={<PaymentsDetailLoading />}>
      <TransactionPageBody />
    </Suspense>
  );
}

function TransactionPageBody() {
  const pathname = usePathname();
  const transactionId = parsePaymentsEntityPath(pathname, "transactions");
  const customer = usePaymentsCustomerQuery();
  const projectId = useProjectId();

  if (transactionId == null) {
    return <PaymentsCustomerQueryMissing title="Transaction" />;
  }
  if (customer == null) {
    return <PaymentsCustomerQueryMissing title="Transaction" />;
  }

  return (
    <Suspense fallback={<PaymentsDetailLoading />}>
      <CustomerHistoryProvider customerType={customer.customerType} customerId={customer.customerId}>
        {({ transactions, truncated }) => {
          const transaction = transactions.find((candidate) => candidate.id === transactionId);
          if (transaction == null) {
            return <TransactionDetailMissing transactionId={transactionId} truncated={truncated} />;
          }
          return (
            <PageLayout>
              <div className="flex flex-col gap-6">
                <PaymentsDetailBackLink
                  href={urlString`/projects/${projectId}/payments/transactions`}
                  label="All transactions"
                />
                <TransactionDetailView transaction={transaction} knownTransactions={transactions} />
              </div>
            </PageLayout>
          );
        }}
      </CustomerHistoryProvider>
    </Suspense>
  );
}
