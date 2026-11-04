'use client';

import { KnownErrors } from "@hexclave/shared";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { useStackApp } from "@hexclave/next";
import { getPublicEnvVar } from "@/lib/env";
import { Section } from "../section";
import { Result } from "@hexclave/shared/dist/utils/results";
import { ActionDialog } from "@/components/ui/action-dialog";
import { CreditCard, Receipt, CaretRight, WarningCircle } from "@phosphor-icons/react";

type CustomerInvoiceStatus = "draft" | "open" | "paid" | "uncollectible" | "void" | null;
type CustomerInvoicesListOptions = { limit?: number; startingAfter?: string };
type CustomerInvoicesList = any[];

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

const formatInvoiceStatus = (status: CustomerInvoiceStatus) => {
  if (status === "draft") return "Draft";
  if (status === "open") return "Open";
  if (status === "paid") return "Paid";
  if (status === "uncollectible") return "Uncollectible";
  if (status === "void") return "Void";
  return "Unknown";
};

const formatInvoiceAmount = (amountTotal: number | null | undefined) => {
  if (typeof amountTotal !== "number" || Number.isNaN(amountTotal)) {
    return "Unknown";
  }
  const normalized = amountTotal / 100;
  const formatted = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(normalized);
  return `$${formatted}`;
};

const formatInvoiceDate = (date: Date | null | undefined) => {
  if (!date || Number.isNaN(date.getTime())) {
    return "Unknown";
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
      prices: Record<string, { interval?: [number, "day" | "week" | "month" | "year"] }>
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-semibold text-foreground">Card Details</label>
        <div className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-zinc-900 p-3.5 shadow-sm">
          <CardElement options={{ hidePostalCode: true, style: { base: { color: darkMode ? "white" : "black", fontSize: "14px" } } }} />
        </div>
      </div>
      {errorMessage && (
        <span className="text-red-500 text-xs font-medium">
          {errorMessage}
        </span>
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
        className="bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 rounded-xl"
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
  const defaultPaymentMethod: PaymentMethodSummary = {
    id: "pm_mock",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
  };

  return (
    <div className="flex flex-col gap-6">
      {props.title && <h3 className="text-lg font-semibold text-foreground">{props.title}</h3>}
      <Section
        title="Payment method"
        description="Manage the default payment method used for subscriptions and invoices."
      >
        <div className="flex items-center gap-3 w-full md:w-[350px]">
          <div className="bg-zinc-100 dark:bg-zinc-900 p-2 rounded-xl border border-black/[0.04] dark:border-white/[0.04] text-foreground shrink-0">
            <CreditCard className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold text-foreground flex-1">{formatPaymentMethod(defaultPaymentMethod)}</span>
          <Button disabled variant="outline" className="border-black/[0.08] dark:border-white/[0.08] rounded-xl text-xs font-semibold px-4 py-2">
            Update
          </Button>
        </div>
      </Section>

      <Section
        title="Active plans"
        description="View your active plans and purchases."
      >
        <div className="flex flex-col gap-4 w-full md:w-[350px]">
          <div className="flex items-center justify-between gap-4 p-3 bg-zinc-50/50 dark:bg-zinc-900/50 border border-black/[0.04] dark:border-white/[0.04] rounded-xl">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground">Pro</span>
              <span className="text-xs text-muted-foreground/80 mt-0.5">Renews on Jan 1, 2030</span>
            </div>
            <Button disabled variant="outline" className="border-black/[0.08] dark:border-white/[0.08] text-xs rounded-xl">
              Cancel
            </Button>
          </div>
          <div className="flex items-center justify-between gap-4 p-3 bg-zinc-50/50 dark:bg-zinc-900/50 border border-black/[0.04] dark:border-white/[0.04] rounded-xl">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground">Credits pack</span>
              <span className="text-xs text-muted-foreground/80 mt-0.5">One-time purchase</span>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function RealPaymentsPanel(props: { title?: string, customer: CustomerLike, customerType: "user" | "team" }) {
  const stackApp = useStackApp();
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
    const publishableKey = getPublicEnvVar("NEXT_PUBLIC_STACK_STRIPE_PUBLISHABLE_KEY");
    if (!publishableKey) return null;
    return loadStripe(publishableKey, { stripeAccount: setupIntentStripeAccountId });
  }, [setupIntentStripeAccountId]);

  const handleAsyncError = (error: unknown) => {
    if (error instanceof KnownErrors.DefaultPaymentMethodRequired) {
      alert("No default payment method added. Add a payment method before switching plans.");
      return;
    }
    alert(`An unhandled error occurred. Please ${process.env.NODE_ENV === "development" ? "check the browser console for the full error." : "report this to the developer."}\n\n${error}`);
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
    <div className="flex flex-col gap-6">
      {props.title && <h3 className="text-lg font-semibold text-foreground">{props.title}</h3>}

      {defaultPaymentMethod && (
        <Section
          title="Payment method"
          description="Manage the default payment method used for subscriptions and invoices."
        >
          <div className="flex items-center gap-3 w-full md:w-[350px]">
            <div className="bg-zinc-100 dark:bg-zinc-900 p-2 rounded-xl border border-black/[0.04] dark:border-white/[0.04] text-foreground shrink-0">
              <CreditCard className="h-5 w-5" />
            </div>
            <span className="text-sm font-semibold text-foreground flex-1">
              {formatPaymentMethod(defaultPaymentMethod)}
            </span>
            <Button
              onClick={openPaymentDialog}
              variant="outline"
              className="border-black/[0.08] dark:border-white/[0.08] hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-xl text-xs font-semibold px-4 py-2 shrink-0"
            >
              Update
            </Button>
          </div>

          <ActionDialog
            open={paymentDialogOpen}
            onOpenChange={(open) => {
              if (!open) closePaymentDialog();
            }}
            title="Update payment method"
          >
            {!setupIntentClientSecret || !setupIntentStripeAccountId || !stripePromise ? (
              <div className="space-y-2 p-1">
                <Skeleton className="h-10 w-full rounded-xl" />
                <Skeleton className="h-[120px] w-full rounded-xl" />
              </div>
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
          title="Active plans"
          description="View your active plans and purchases."
        >
          <div className="flex flex-col gap-3 w-full md:w-[350px]">
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
                  ? "One-time purchase"
                  : endsAtPeriodEnd
                    ? (formattedPeriodEnd ? `Ends on ${formattedPeriodEnd}` : "Ends at the end of the billing period")
                    : formattedPeriodEnd
                      ? `Renews on ${formattedPeriodEnd}`
                      : "Subscription";

              return (
                <div key={product.id ?? `${product.displayName}-${index}`} className="flex items-center justify-between gap-4 p-3 bg-zinc-50/50 dark:bg-zinc-900/50 border border-black/[0.04] dark:border-white/[0.04] rounded-xl">
                  <div className="min-w-0 flex flex-col">
                    <span className="text-sm font-semibold text-foreground truncate">{product.displayName}{quantitySuffix}</span>
                    <span className="text-xs text-muted-foreground/80 mt-0.5">{subtitle}</span>
                  </div>

                  <div className="flex gap-2 shrink-0">
                    {canSwitchPlans && (
                      <Button
                        variant="outline"
                        onClick={() => openSwitchDialog(product.id!, product.switchOptions?.[0]?.productId ?? null)}
                        className="border-black/[0.08] dark:border-white/[0.08] hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-xl text-xs px-3 py-1.5"
                      >
                        Change
                      </Button>
                    )}
                    {isCancelable && (
                      <Button
                        variant="outline"
                        onClick={() => setCancelTarget({ productId: product.id ?? "_inline", subscriptionId: product.subscription?.subscriptionId ?? undefined })}
                        className="border-black/[0.08] dark:border-white/[0.08] hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-xl text-xs text-red-500 hover:text-red-600 px-3 py-1.5"
                      >
                        Cancel
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
            title="Cancel subscription"
            danger
            cancelButton
            okButton={{
              label: "Cancel subscription",
              onClick: async () => {
                if (!cancelTarget) return;
                const { productId, subscriptionId } = cancelTarget;
                if (props.customerType === "team") {
                  await stackApp.cancelSubscription({ teamId: props.customer.id, productId, subscriptionId });
                } else {
                  await stackApp.cancelSubscription({ productId, subscriptionId });
                }
                setCancelTarget(null);
              },
            }}
          >
            <span className="text-sm text-foreground/90 leading-relaxed">
              Canceling will stop future renewals for this subscription. This action is safe and will take effect at the end of the billing period.
            </span>
          </ActionDialog>

          <ActionDialog
            open={switchFromProductId !== null}
            onOpenChange={(open) => {
              if (!open) closeSwitchDialog();
            }}
            title="Change plan"
            cancelButton
            okButton={{
              label: "Switch plan",
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
            <div className="space-y-4">
              {switchOptions.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  No other plans available for this subscription.
                </span>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Choose a plan</label>
                  <Select
                    value={switchToProductId ?? undefined}
                    onValueChange={(value) => setSwitchToProductId(value || null)}
                  >
                    <SelectTrigger className="w-full bg-white dark:bg-zinc-900 border-black/[0.08] dark:border-white/[0.08] rounded-xl px-3 py-2 shadow-sm focus-visible:ring-black/[0.06] dark:focus-visible:ring-white/[0.06]">
                      <SelectValue placeholder="Choose a plan" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl border-black/[0.08] dark:border-white/[0.08] shadow-md">
                      {switchOptions.map((option: any) => (
                        <SelectItem key={option.productId} value={option.productId} className="rounded-lg">
                          {option.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </ActionDialog>
        </Section>
      )}

      {invoices.length > 0 && (
        <div className="border border-black/[0.08] dark:border-white/[0.08] bg-white/80 dark:bg-background/80 backdrop-blur-xl rounded-2xl p-6 shadow-sm ring-1 ring-black/[0.04] dark:ring-0 flex flex-col gap-5">
          <div>
            <h3 className="font-semibold text-base text-foreground leading-snug">
              Past Invoices
            </h3>
            <p className="text-muted-foreground text-sm mt-1 leading-relaxed">
              Review your receipts and past billing logs.
            </p>
          </div>

          <div className="border border-black/[0.06] dark:border-white/[0.06] rounded-xl overflow-hidden shadow-sm">
            <Table>
              <TableHeader className="bg-zinc-50/50 dark:bg-zinc-900/50">
                <TableRow className="border-b border-black/[0.06] dark:border-white/[0.06]">
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">Date</TableHead>
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">Status</TableHead>
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">Amount</TableHead>
                  <TableHead className="py-3 px-4 text-right w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices as any[]).map((invoice: any, index: number) => {
                  const createdAtTime = new Date(invoice.createdAt).getTime();
                  const invoiceKey = Number.isNaN(createdAtTime) ? `invoice-${index}` : `invoice-${createdAtTime}-${index}`;
                  return (
                    <TableRow key={invoiceKey} className="border-b border-black/[0.04] dark:border-white/[0.04] last:border-b-0 hover:bg-zinc-50/30 dark:hover:bg-zinc-900/30 transition-colors duration-150">
                      <TableCell className="py-3.5 px-4 text-sm font-semibold text-foreground/90">
                        {formatInvoiceDate(invoice.createdAt)}
                      </TableCell>
                      <TableCell className="py-3.5 px-4 text-xs font-semibold">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          invoice.status === "paid"
                            ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400 border border-green-200 dark:border-green-900/30"
                            : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200 dark:border-amber-900/30"
                        }`}>
                          {formatInvoiceStatus(invoice.status)}
                        </span>
                      </TableCell>
                      <TableCell className="py-3.5 px-4 text-sm font-medium text-foreground/90">
                        {formatInvoiceAmount(invoice.amountTotal)}
                      </TableCell>
                      <TableCell className="py-3.5 px-4 text-right">
                        {invoice.hostedInvoiceUrl ? (
                          <Button asChild variant="outline" className="border-black/[0.08] dark:border-white/[0.08] hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-xl text-xs font-semibold px-3 py-1.5">
                            <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                              View <CaretRight className="h-3 w-3" />
                            </a>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unavailable</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
