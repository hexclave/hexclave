'use client';

import { KnownErrors } from "@hexclave/shared";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ActionDialog, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast, Typography } from "@hexclave/ui";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { useStackApp } from "../../..";
import { envVars } from "../../../generated/env";
import { useTranslation } from "../../../lib/translations";
import { Section } from "../section";
import { Result } from "@hexclave/shared/dist/utils/results";
import type { CustomerInvoiceStatus, CustomerInvoicesList, CustomerInvoicesListOptions } from "../../../lib/hexclave-app/customers";

type PaymentMethodSummary = {
  id: string,
  brand: string | null,
  last4: string | null,
  exp_month: number | null,
  exp_year: number | null,
} | null;

function formatPaymentMethod(pm: NonNullable<PaymentMethodSummary>) {
  const details = [
    pm.brand ? pm.brand.toUpperCase() : null,
    pm.last4 ? `•••• ${pm.last4}` : null,
    pm.exp_month && pm.exp_year ? `exp ${pm.exp_month}/${pm.exp_year}` : null,
  ].filter(Boolean);
  return details.join(" · ");
}

const formatInvoiceStatus = (status: CustomerInvoiceStatus, t: (value: string) => string) => {
  if (!status) {
    return t("Unknown");
  }
  switch (status) {
    case "draft": {
      return t("Draft");
    }
    case "open": {
      return t("Open");
    }
    case "paid": {
      return t("Paid");
    }
    case "uncollectible": {
      return t("Uncollectible");
    }
    case "void": {
      return t("Void");
    }
    default: {
      return t("Unknown");
    }
  }
};

const formatInvoiceAmount = (amountTotal: number | null | undefined, t: (value: string) => string) => {
  if (typeof amountTotal !== "number" || Number.isNaN(amountTotal)) {
    return t("Unknown");
  }
  const normalized = amountTotal / 100;
  const formatted = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(normalized);
  return `$${formatted}`;
};

const formatInvoiceDate = (date: Date | null | undefined, t: (value: string) => string) => {
  if (!date || Number.isNaN(date.getTime())) {
    return t("Unknown");
  }
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
};

type CustomerBilling = {
  hasCustomer: boolean,
  defaultPaymentMethod: PaymentMethodSummary,
};

type CustomerPaymentMethodSetupIntent = {
  clientSecret: string,
  stripeAccountId: string,
};

type CustomerLike = {
  id: string,
  useBilling: () => CustomerBilling,
  useProducts: () => Array<{
    id: string | null,
    quantity: number,
    displayName: string,
    customerType: "user" | "team" | "custom",
    type?: "one_time" | "subscription",
    switchOptions?: Array<{
      productId: string,
      displayName: string,
      prices: Record<string, { interval?: [number, "day" | "week" | "month" | "year"] }>,
    }>,
    subscription: null | {
      subscriptionId: string | null,
      currentPeriodEnd: Date | null,
      cancelAtPeriodEnd: boolean,
      isCancelable: boolean,
    },
  }>,
  useInvoices: (options?: CustomerInvoicesListOptions) => CustomerInvoicesList,
  createPaymentMethodSetupIntent: () => Promise<CustomerPaymentMethodSetupIntent>,
  setDefaultPaymentMethodFromSetupIntent: (setupIntentId: string) => Promise<PaymentMethodSummary>,
  switchSubscription: (options: { fromProductId: string, toProductId: string, priceId?: string, quantity?: number }) => Promise<void>,
};

function SetDefaultPaymentMethodForm(props: {
  clientSecret: string,
  onSetupIntentSucceeded: (setupIntentId: string) => Promise<void>,
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const darkMode = "color-scheme" in document.documentElement.style && document.documentElement.style["color-scheme"] === "dark";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Typography className="font-medium">Card details</Typography>
        <div className="rounded-md border border-input p-3">
          <CardElement options={{ hidePostalCode: true, style: { base: { color: darkMode ? "white" : "black" } } }} />
        </div>
      </div>
      {errorMessage && (
        <Typography variant="secondary" type="footnote">
          {errorMessage}
        </Typography>
      )}
      <Button
        onClick={async () => {
          if (!stripe || !elements) {
            setErrorMessage("Stripe is still loading. Please try again.");
            return;
          }
          const card = elements.getElement(CardElement);
          if (!card) {
            setErrorMessage("Card element not found.");
            return;
          }

          const result = await stripe.confirmCardSetup(props.clientSecret, {
            payment_method: { card },
          });
          if (result.error) {
            setErrorMessage(result.error.message ?? "Failed to save payment method.");
            return;
          }
          if (!result.setupIntent.id) {
            setErrorMessage("No setup intent returned from Stripe.");
            return;
          }
          await props.onSetupIntentSucceeded(result.setupIntent.id);
        }}
      >
        Save payment method
      </Button>
    </div>
  );
}

export function PaymentsPanel(props: {
  title?: string,
  customer?: CustomerLike,
  customerType?: "user" | "team",
  mockMode?: boolean,
}) {
  if (props.mockMode) {
    return <MockPaymentsPanel title={props.title} />;
  }
  if (!props.customer) {
    return null;
  }
  return <RealPaymentsPanel title={props.title} customer={props.customer} customerType={props.customerType ?? "user"} />;
}

function MockPaymentsPanel(props: { title?: string }) {
  const { t } = useTranslation();
  const defaultPaymentMethod: PaymentMethodSummary = {
    id: "pm_mock",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
  };

  return (
    <div className="space-y-4">
      {props.title && <Typography className="font-medium">{props.title}</Typography>}
      <Section
        title={t("Payment method")}
        description={t("Manage the default payment method used for subscriptions and invoices.")}
      >
        <Typography>{formatPaymentMethod(defaultPaymentMethod)}</Typography>
        <Button disabled>
          {t("Update payment method")}
        </Button>
      </Section>

      <Section
        title={t("Active plans")}
        description={t("View your active plans and purchases.")}
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Typography className="truncate">{t("Pro")}</Typography>
              <Typography variant="secondary" type="footnote">{t("Renews on")} Jan 1, 2030</Typography>
            </div>
            <Button disabled variant="secondary" color="neutral">
              {t("Cancel subscription")}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Typography className="truncate">{t("Credits pack")}</Typography>
              <Typography variant="secondary" type="footnote">{t("One-time purchase")}</Typography>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function RealPaymentsPanel(props: { title?: string, customer: CustomerLike, customerType: "user" | "team" }) {
  const { t } = useTranslation();
  const hexclaveApp = useStackApp();
  const billing = props.customer.useBilling();
  const defaultPaymentMethod = billing.defaultPaymentMethod;
  const products = props.customer.useProducts();
  const invoices = props.customer.useInvoices({ limit: 10 });
  const productsForCustomerType = products.filter(product => product.customerType === props.customerType);

  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [setupIntentClientSecret, setSetupIntentClientSecret] = useState<string | null>(null);
  const [setupIntentStripeAccountId, setSetupIntentStripeAccountId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ productId: string, subscriptionId?: string } | null>(null);
  const [switchFromProductId, setSwitchFromProductId] = useState<string | null>(null);
  const [switchToProductId, setSwitchToProductId] = useState<string | null>(null);

  const stripePromise = useMemo(() => {
    if (!setupIntentStripeAccountId) return null;
    const publishableKey = envVars.HEXCLAVE_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) return null;
    return loadStripe(publishableKey, { stripeAccount: setupIntentStripeAccountId });
  }, [setupIntentStripeAccountId]);

  const handleAsyncError = (error: unknown) => {
    if (error instanceof KnownErrors.DefaultPaymentMethodRequired) {
      toast({
        title: t("No default payment method"),
        description: t("Add a payment method before switching plans."),
        variant: "destructive",
      });
      return;
    }
    alert(`An unhandled error occurred. Please ${envVars.NODE_ENV === "development" ? "check the browser console for the full error." : "report this to the developer."}\n\n${error}`);
  };

  const openPaymentDialog = () => {
    runAsynchronously(async () => {
      setPaymentDialogOpen(true);
      const res = await props.customer.createPaymentMethodSetupIntent();
      setSetupIntentClientSecret(res.clientSecret);
      setSetupIntentStripeAccountId(res.stripeAccountId);
    }, { onError: handleAsyncError });
  };

  const closePaymentDialog = () => {
    setPaymentDialogOpen(false);
    setSetupIntentClientSecret(null);
    setSetupIntentStripeAccountId(null);
  };

  const openSwitchDialog = (productId: string, firstOptionId: string | null) => {
    setSwitchFromProductId(productId);
    setSwitchToProductId(firstOptionId);
  };

  const closeSwitchDialog = () => {
    setSwitchFromProductId(null);
    setSwitchToProductId(null);
  };

  const switchSourceProduct = switchFromProductId
    ? productsForCustomerType.find((product) => product.id === switchFromProductId) ?? null
    : null;
  const switchOptions = switchSourceProduct?.switchOptions ?? [];
  const selectedSwitchOption = switchOptions.find((option) => option.productId === switchToProductId) ?? null;
  const selectedPriceId = selectedSwitchOption ? (Object.keys(selectedSwitchOption.prices)[0] ?? null) : null;

  return (
    <div className="space-y-4">
      {props.title && <Typography className="font-medium">{props.title}</Typography>}

      {defaultPaymentMethod && (
        <Section
          title={t("Payment method")}
          description={t("Manage the default payment method used for subscriptions and invoices.")}
        >
          <Typography>{formatPaymentMethod(defaultPaymentMethod)}</Typography>

          <Button onClick={openPaymentDialog}>
            {t("Update payment method")}
          </Button>

          <ActionDialog
            open={paymentDialogOpen}
            onOpenChange={(open) => {
              if (!open) {
                closePaymentDialog();
              } else {
                setPaymentDialogOpen(true);
              }
            }}
            title={t("Update payment method")}
          >
            {!setupIntentClientSecret || !setupIntentStripeAccountId || !stripePromise ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Elements
                stripe={stripePromise}
                options={{
                  clientSecret: setupIntentClientSecret,
                }}
              >
                <SetDefaultPaymentMethodForm
                  clientSecret={setupIntentClientSecret}
                  onSetupIntentSucceeded={async (setupIntentId) => {
                    await props.customer.setDefaultPaymentMethodFromSetupIntent(setupIntentId);
                    closePaymentDialog();
                  }}
                />
              </Elements>
            )}
          </ActionDialog>
        </Section>
      )}

      {productsForCustomerType.length > 0 && (
        <Section
          title={t("Active plans")}
          description={t("View your active plans and purchases.")}
        >
          <div className="space-y-3">
            {productsForCustomerType.map((product, index) => {
              const quantitySuffix = product.quantity !== 1 ? ` ×${product.quantity}` : "";
              const isSubscription = product.type === "subscription";
              const isCancelable = isSubscription && !!product.subscription?.isCancelable;
              const canSwitchPlans = isSubscription && defaultPaymentMethod && !!product.id && (product.switchOptions?.length ?? 0) > 0;
              const renewsAt = isSubscription ? (product.subscription?.currentPeriodEnd ?? null) : null;
              const endsAtPeriodEnd = isSubscription && !!product.subscription?.cancelAtPeriodEnd;
              const formattedPeriodEnd = renewsAt
                ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(renewsAt)
                : null;
              const subtitle =
                product.type === "one_time"
                  ? t("One-time purchase")
                  : endsAtPeriodEnd
                    ? (formattedPeriodEnd ? `${t("Ends on")} ${formattedPeriodEnd}` : t("Ends at the end of the billing period"))
                    : formattedPeriodEnd
                      ? `${t("Renews on")} ${formattedPeriodEnd}`
                      : t("Subscription");

              return (
                <div key={product.id ?? `${product.displayName}-${index}`} className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Typography className="truncate">{product.displayName}{quantitySuffix}</Typography>
                    <Typography variant="secondary" type="footnote">{subtitle}</Typography>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    {canSwitchPlans && (
                      <Button
                        variant="secondary"
                        color="neutral"
                        onClick={() => openSwitchDialog(product.id!, product.switchOptions?.[0]?.productId ?? null)}
                      >
                        {t("Change plan")}
                      </Button>
                    )}
                    {isCancelable && (
                      <Button
                        variant="secondary"
                        color="neutral"
                        onClick={() => setCancelTarget({ productId: product.id ?? "_inline", subscriptionId: product.subscription?.subscriptionId ?? undefined })}
                      >
                        {t("Cancel subscription")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <ActionDialog
            open={cancelTarget !== null}
            onOpenChange={(open) => {
              if (!open) setCancelTarget(null);
            }}
            title={t("Cancel subscription")}
            description={t("Canceling will stop future renewals for this subscription.")}
            danger
            cancelButton
            okButton={{
              label: t("Cancel subscription"),
              onClick: async () => {
                if (!cancelTarget) return;
                const { productId, subscriptionId } = cancelTarget;
                if (props.customerType === "team") {
                  await hexclaveApp.cancelSubscription({ teamId: props.customer.id, productId, subscriptionId });
                } else {
                  await hexclaveApp.cancelSubscription({ productId, subscriptionId });
                }
                setCancelTarget(null);
              },
            }}
          />

          <ActionDialog
            open={switchFromProductId !== null}
            onOpenChange={(open) => {
              if (!open) closeSwitchDialog();
            }}
            title={t("Change plan")}
            description={t("Select a new plan from the same product line.")}
            cancelButton
            okButton={{
              label: t("Switch plan"),
              onClick: async () => {
                const fromProductId = switchFromProductId;
                const toProductId = switchToProductId;
                if (!fromProductId || !toProductId) return;
                if (!selectedPriceId) return;
                const result = await Result.fromThrowingAsync(() => props.customer.switchSubscription({
                  fromProductId,
                  toProductId,
                  priceId: selectedPriceId,
                }));
                if (result.status === "error") {
                  handleAsyncError(result.error);
                  return "prevent-close";
                }
                closeSwitchDialog();
              },
              props: {
                disabled: !switchFromProductId || !switchToProductId || !selectedPriceId,
              },
            }}
          >
            <div className="space-y-2">
              {switchOptions.length === 0 ? (
                <Typography variant="secondary" type="footnote">
                  {t("No other plans available for this subscription.")}
                </Typography>
              ) : (
                <>
                  <Typography type="footnote">{t("Choose a plan")}</Typography>
                  <Select
                    value={switchToProductId ?? undefined}
                    onValueChange={(value) => setSwitchToProductId(value || null)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("Choose a plan")} />
                    </SelectTrigger>
                    <SelectContent>
                      {switchOptions.map((option: NonNullable<typeof switchOptions>[number]) => (
                        <SelectItem key={option.productId} value={option.productId}>
                          {option.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
          </ActionDialog>
        </Section>
      )
      }
      {invoices.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <div className="space-y-1">
              <Typography className="font-medium">{t("Invoices")}</Typography>
              <Typography variant="secondary" type="footnote">{t("Review past invoices and receipts.")}</Typography>
            </div>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">{t("Date")}</TableHead>
                    <TableHead className="w-[120px]">{t("Status")}</TableHead>
                    <TableHead className="w-[120px]">{t("Amount")}</TableHead>
                    <TableHead className="w-[120px] text-right">{t("Invoice")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice, index) => {
                    const createdAtTime = invoice.createdAt.getTime();
                    const invoiceKey = Number.isNaN(createdAtTime) ? `invoice-${index}` : `invoice-${createdAtTime}-${index}`;
                    return (
                      <TableRow key={invoiceKey}>
                        <TableCell>
                          <Typography>{formatInvoiceDate(invoice.createdAt, t)}</Typography>
                        </TableCell>
                        <TableCell>
                          <Typography>{formatInvoiceStatus(invoice.status, t)}</Typography>
                        </TableCell>
                        <TableCell>
                          <Typography>{formatInvoiceAmount(invoice.amountTotal, t)}</Typography>
                        </TableCell>
                        <TableCell align="right">
                          {invoice.hostedInvoiceUrl ? (
                            <Button asChild variant="secondary" color="neutral" size="sm">
                              <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                                {t("View")}
                              </a>
                            </Button>
                          ) : (
                            <Typography variant="secondary" type="footnote">
                              {t("Unavailable")}
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div >
  );
}
