import { ActionDialog, Button, Skeleton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui";
import { KnownErrors } from "@hexclave/shared";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { useStackApp } from "@hexclave/react";
import { Section } from "../section";
import { Result } from "@hexclave/shared/dist/utils/results";
import { CreditCard, Receipt, CaretRight, WarningCircle } from "@phosphor-icons/react";
import {
  getCardClassName,
  getFieldClassName,
  getIconContainerClassName,
  getInsetPanelClassName,
  getOutlineButtonClassName,
  getPrimaryButtonClassName,
  getSectionDescriptionClassName,
  getSectionTitleClassName,
  useDesign,
} from "../design-context";

function getHostedStripePublishableKey() {
  return import.meta.env.VITE_HEXCLAVE_STRIPE_PUBLISHABLE_KEY ?? import.meta.env.VITE_STACK_STRIPE_PUBLISHABLE_KEY;
}

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

function promoApplyErrorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof KnownErrors.PromoCodesDisabled
    || error instanceof KnownErrors.PromoCodeStackingDisabled
    || error instanceof KnownErrors.PromoCodeInvalid
    || error instanceof KnownErrors.PromoCodeNotFound
    || error instanceof KnownErrors.PromoCodePaused
    || error instanceof KnownErrors.PromoCodeEnded
    || error instanceof KnownErrors.PromoCodeExpired
    || error instanceof KnownErrors.PromoCodeNotYetAvailable
    || error instanceof KnownErrors.PromoCodeNotApplicableToProduct
    || error instanceof KnownErrors.PromoCodeRedemptionLimitReached
    || error instanceof KnownErrors.PromoCodeStackingNotAllowed
    || error instanceof KnownErrors.PromoCodeNothingToDiscount
    || error instanceof KnownErrors.PromoCodeDiscountBelowMinimum
  ) {
    return error.message;
  }
  return fallback;
}

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
  switchSubscription: (options: { fromProductId: string, toProductId: string, priceId?: string, quantity?: number, promoCodes?: string[] }) => Promise<void>,
  validatePromoCodes: (options: { productId: string, priceId?: string, quantity?: number, promoCodes: string[] }) => Promise<{ originalAmount: string, netAmount: string, recurringAmount: string, appliedCodeNames: string[] }>,
};

function SetDefaultPaymentMethodForm(props: {
  clientSecret: string,
  onSetupIntentSucceeded: (setupIntentId: string) => Promise<void>,
}) {
  const design = useDesign();
  const stripe = useStripe();
  const elements = useElements();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const darkMode = "color-scheme" in document.documentElement.style && document.documentElement.style["color-scheme"] === "dark";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-semibold text-foreground">Card Details</label>
        <div className={getFieldClassName(design, "p-3.5")}>
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
        className={getPrimaryButtonClassName(design)}
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
  const design = useDesign();
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
          <div className={getIconContainerClassName(design)}>
            <CreditCard className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold text-foreground flex-1">{formatPaymentMethod(defaultPaymentMethod)}</span>
          <Button disabled variant="outline" className={getOutlineButtonClassName(design, "text-xs font-semibold px-4 py-2")}>
            Update
          </Button>
        </div>
      </Section>

      <Section
        title="Active plans"
        description="View your active plans and purchases."
      >
        <div className="flex flex-col gap-4 w-full md:w-[350px]">
          <div className={getInsetPanelClassName(design, "flex items-center justify-between gap-4 p-3")}>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground">Pro</span>
              <span className="text-xs text-muted-foreground/80 mt-0.5">Renews on Jan 1, 2030</span>
            </div>
            <Button disabled variant="outline" className={getOutlineButtonClassName(design, "text-xs")}>
              Cancel
            </Button>
          </div>
          <div className={getInsetPanelClassName(design, "flex items-center justify-between gap-4 p-3")}>
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
  const design = useDesign();
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
  const [appliedPromoCodeNames, setAppliedPromoCodeNames] = useState<string[]>([]);
  const [promoDraft, setPromoDraft] = useState("");
  const [promoError, setPromoError] = useState<string | null>(null);
  const project = stackApp.useProject();
  const allowPromoCodes = project.config.allowPromoCodes === true;
  const allowStackingPromoCodes = allowPromoCodes && project.config.allowStackingPromoCodes === true;

  const stripePromise = useMemo(() => {
    if (!setupIntentStripeAccountId) return null;
    const publishableKey = getHostedStripePublishableKey();
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
    setAppliedPromoCodeNames([]);
    setPromoDraft("");
    setPromoError(null);
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
            <div className={getIconContainerClassName(design)}>
              <CreditCard className="h-5 w-5" />
            </div>
            <span className="text-sm font-semibold text-foreground flex-1">
              {formatPaymentMethod(defaultPaymentMethod)}
            </span>
            <Button
              onClick={openPaymentDialog}
              variant="outline"
              className={getOutlineButtonClassName(design, "text-xs font-semibold px-4 py-2 shrink-0")}
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
              <div className="space-y-4 p-1">
                <div className="space-y-2">
                  <Skeleton className="h-3 w-28 rounded-full" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-14 rounded-full" />
                    <Skeleton className="h-10 w-full rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-12 rounded-full" />
                    <Skeleton className="h-10 w-full rounded-lg" />
                  </div>
                </div>
                <Skeleton className="h-9 w-full rounded-lg" />
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
              const subtitle =
                product.type === "one_time"
                  ? "One-time purchase"
                  : renewsAt
                    ? `Renews on ${new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(renewsAt)}`
                    : "Subscription";

              return (
                <div key={product.id ?? `${product.displayName}-${index}`} className={getInsetPanelClassName(design, "flex items-center justify-between gap-4 p-3")}>
                  <div className="min-w-0 flex flex-col">
                    <span className="text-sm font-semibold text-foreground truncate">{product.displayName}{quantitySuffix}</span>
                    <span className="text-xs text-muted-foreground/80 mt-0.5">{subtitle}</span>
                  </div>

                  <div className="flex gap-2 shrink-0">
                    {canSwitchPlans && (
                      <Button
                        variant="outline"
                        onClick={() => openSwitchDialog(product.id!, product.switchOptions?.[0]?.productId ?? null)}
                        className={getOutlineButtonClassName(design, "text-xs px-3 py-1.5")}
                      >
                        Change
                      </Button>
                    )}
                    {isCancelable && (
                      <Button
                        variant="outline"
                        onClick={() => setCancelTarget({ productId: product.id ?? "_inline", subscriptionId: product.subscription?.subscriptionId ?? undefined })}
                        className={getOutlineButtonClassName(design, "text-xs text-red-500 hover:text-red-600 px-3 py-1.5")}
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
                  promoCodes: appliedPromoCodeNames,
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
                    onValueChange={(value) => {
                      setSwitchToProductId(value || null);
                      setAppliedPromoCodeNames([]);
                      setPromoDraft("");
                      setPromoError(null);
                    }}
                  >
                    <SelectTrigger className={getFieldClassName(design, "w-full px-3 py-2")}>
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
              {allowPromoCodes && switchToProductId != null && selectedPriceId != null && (
                <div className="flex flex-col gap-2">
                  {appliedPromoCodeNames.map((codeName) => (
                    <div key={codeName} className="flex items-center justify-between text-sm">
                      <span>With Code {codeName}</span>
                      <Button
                        variant="ghost"
                        className="text-xs"
                        onClick={() => setAppliedPromoCodeNames((current) => current.filter((name) => name !== codeName))}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  {(appliedPromoCodeNames.length === 0 || allowStackingPromoCodes) && (
                    <div className="flex gap-2">
                      <input
                        className={getFieldClassName(design, "flex-1 px-3 py-2 text-sm")}
                        value={promoDraft}
                        onChange={(event) => setPromoDraft(event.target.value)}
                        placeholder="Promo code"
                      />
                      <Button
                        variant="outline"
                        className={getOutlineButtonClassName(design)}
                        disabled={promoDraft.trim().length === 0}
                        onClick={async () => {
                          setPromoError(null);
                          const requestedProductId = switchToProductId;
                          const requestedPriceId = selectedPriceId;
                          const result = await Result.fromThrowingAsync(() => props.customer.validatePromoCodes({
                            productId: requestedProductId,
                            priceId: requestedPriceId,
                            promoCodes: [...appliedPromoCodeNames, promoDraft.trim()],
                          }));
                          if (switchToProductId !== requestedProductId || selectedPriceId !== requestedPriceId) {
                            return;
                          }
                          if (result.status === "error") {
                            setPromoError(promoApplyErrorMessage(result.error, "This promo code could not be applied."));
                            return;
                          }
                          setAppliedPromoCodeNames(result.data.appliedCodeNames);
                          setPromoDraft("");
                        }}
                      >
                        Apply
                      </Button>
                    </div>
                  )}
                  {promoError != null && (
                    <span className="text-red-500 text-xs font-medium">{promoError}</span>
                  )}
                </div>
              )}
            </div>
          </ActionDialog>
        </Section>
      )}

      {invoices.length > 0 && (
        <div className={getCardClassName(design, "flex flex-col gap-5")}>
          <div>
            <h3 className={getSectionTitleClassName(design)}>
              Past Invoices
            </h3>
            <p className={getSectionDescriptionClassName(design)}>
              Review your receipts and past billing logs.
            </p>
          </div>

          <div className={getInsetPanelClassName(design, "overflow-hidden p-0")}>
            <Table>
              <TableHeader className="bg-muted/30">
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
                    <TableRow key={invoiceKey} className="border-b border-black/[0.04] dark:border-white/[0.04] last:border-b-0 hover:bg-zinc-50/30 dark:hover:bg-zinc-800/25 transition-colors duration-150">
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
                          <Button asChild variant="outline" className={getOutlineButtonClassName(design, "text-xs font-semibold px-3 py-1.5")}>
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
