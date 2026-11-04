"use client";

import { CheckoutForm, PaymentsNotEnabledCard, TestModeBypassForm } from "@/components/payments/checkout";
import { PromoCodeApplyField, promoCodeErrorMessage } from "@/components/payments/promo-code-apply";
import { PurchasePriceOption } from "@/components/payments/purchase-price-option";
import { PurchaseQuantitySelector } from "@/components/payments/purchase-quantity-selector";
import { isFreePrice, shortenedInterval } from "@/components/payments/purchase-utils";
import { StripeElementsProvider } from "@/components/payments/stripe-elements-provider";
import { DesignAlert } from "@/components/design-components/alert";
import { DesignCard } from "@/components/design-components/card";
import { Skeleton, Typography } from "@/components/ui";
import { XCircleIcon } from "@phosphor-icons/react";
import { inlineProductSchema } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { getApiBaseUrl } from "../get-api-base-url";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as yup from "yup";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

type ProductData = {
  product?: Omit<yup.InferType<typeof inlineProductSchema>, "included_items" | "server_only"> & { stackable: boolean },
  stripe_account_id: string | null,
  project_id: string,
  project_logo_url: string | null,
  already_bought_non_stackable?: boolean,
  conflicting_products?: { product_id: string, display_name: string }[],
  replaces_stripe_subscription?: boolean,
  test_mode: boolean,
  charges_enabled: boolean | null,
  allow_promo_codes: boolean,
  allow_stacking_promo_codes: boolean,
};

const MAX_STRIPE_AMOUNT_CENTS = 999_999 * 100;
const GENERIC_PURCHASE_FAILURE_MESSAGE = "We couldn't complete the purchase. Please try again.";
const GENERIC_TEST_MODE_PURCHASE_FAILURE_MESSAGE = "We couldn't complete the test purchase. Please try again.";

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getResponseCode(responseBody: unknown) {
  if (typeof responseBody === "object" && responseBody !== null && "code" in responseBody && typeof responseBody.code === "string") {
    return responseBody.code;
  }
  return null;
}

function getPurchaseFailureMessage(responseBody: unknown, fallbackMessage: string) {
  if (getResponseCode(responseBody) !== null && typeof responseBody === "object" && responseBody !== null && "error" in responseBody && typeof responseBody.error === "string") {
    return responseBody.error;
  }
  return fallbackMessage;
}

function getClientSecret(responseBody: unknown) {
  if (typeof responseBody === "object" && responseBody !== null && "client_secret" in responseBody && typeof responseBody.client_secret === "string") {
    return responseBody.client_secret;
  }
  return null;
}

function getStripeIntentType(responseBody: unknown): "payment" | "setup" {
  if (
    typeof responseBody === "object"
    && responseBody !== null
    && "stripe_intent_type" in responseBody
    && (responseBody.stripe_intent_type === "payment" || responseBody.stripe_intent_type === "setup")
  ) {
    return responseBody.stripe_intent_type;
  }
  // Older responses / one-time paths without the field are payment intents.
  return "payment";
}

export default function PageClient({ code }: { code: string }) {
  const [data, setData] = useState<ProductData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A missing NEXT_PUBLIC_STACK_API_URL is a deployment/config error, not a bad purchase
  // code. getApiBaseUrl() can only run client-side (the var is blank during prerender), so we
  // resolve it in the effect below and surface a failure here loudly via the error boundary
  // instead of letting it fall into the "Invalid Purchase Code" catch path.
  const [configError, setConfigError] = useState<unknown>(null);
  const [selectedPriceId, setSelectedPriceId] = useState<string | null>(null);
  const [quantityInput, setQuantityInput] = useState<string>("1");
  const [appliedPromoCodeNames, setAppliedPromoCodeNames] = useState<string[]>([]);
  const [promoNetCents, setPromoNetCents] = useState<number | null>(null);
  const [promoRecurringCents, setPromoRecurringCents] = useState<number | null>(null);
  const [promoSubmitError, setPromoSubmitError] = useState<string | null>(null);
  const [promoValidationInFlight, setPromoValidationInFlight] = useState(false);
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("return_url");

  const quantityNumber = useMemo((): number => {
    const n = parseInt(quantityInput, 10);
    if (Number.isNaN(n)) {
      return 0;
    }
    return n;
  }, [quantityInput]);

  const selectedPriceIdRef = useRef(selectedPriceId);
  selectedPriceIdRef.current = selectedPriceId;
  const quantityNumberRef = useRef(quantityNumber);
  quantityNumberRef.current = quantityNumber;
  const promoValidateGenerationRef = useRef(0);

  const unitCents = useMemo((): number => {
    if (!selectedPriceId || !data?.product?.prices) {
      return 0;
    }
    const usd = data.product.prices[selectedPriceId].USD;
    if (usd == null) {
      return 0;
    }
    // Never `Number(USD) * 100` — e.g. 79.99 → 7998.999999999999, which Stripe
    // Elements/API reject as parameter_invalid_integer.
    return moneyAmountToStripeUnits(usd as MoneyAmount, USD_CURRENCY);
  }, [data, selectedPriceId]);

  const rawAmountCents = useMemo(() => {
    return unitCents * Math.max(0, quantityNumber);
  }, [unitCents, quantityNumber]);

  const isTooLarge = rawAmountCents > MAX_STRIPE_AMOUNT_CENTS;

  // Price-level free_trial preferred; product-level is transitional fallback.
  const hasSelectedFreeTrial = useMemo(() => {
    if (!selectedPriceId || !data?.product?.prices) return false;
    const price = data.product.prices[selectedPriceId];
    return !!(price.free_trial ?? data.product.free_trial);
  }, [data, selectedPriceId]);

  // purchase-session intentionally omits trial_period_days on in-place Stripe
  // subscription updates (plan switch / conflict replace). If we still mounted
  // Elements in setup mode from product config alone, confirmPayment would fail
  // with a Stripe mode mismatch against the PaymentIntent that path returns.
  const appliesFreeTrialAtCheckout = useMemo(() => {
    if (!hasSelectedFreeTrial) return false;
    if (data?.replaces_stripe_subscription === true) return false;
    return true;
  }, [hasSelectedFreeTrial, data?.replaces_stripe_subscription]);

  const catalogAmountCents = useMemo(() => {
    if (!unitCents) return 0;
    if (rawAmountCents < 1) return unitCents;
    if (isTooLarge) return MAX_STRIPE_AMOUNT_CENTS;
    return rawAmountCents;
  }, [unitCents, rawAmountCents, isTooLarge]);

  const elementsAmountCents = useMemo(() => {
    // Immediate charge is $0 during a free trial — Stripe Elements amount should
    // reflect what the customer pays now (SetupIntent / deferred charge).
    if (appliesFreeTrialAtCheckout) return 0;
    if (promoNetCents != null) return promoNetCents;
    return catalogAmountCents;
  }, [appliesFreeTrialAtCheckout, promoNetCents, catalogAmountCents]);

  const validatePromoCodes = useCallback(async (codeNames: string[]) => {
    const generation = ++promoValidateGenerationRef.current;
    const requestedPriceId = selectedPriceId;
    const requestedQuantity = quantityNumber;
    const baseUrl = getApiBaseUrl();
    const response = await fetch(`${baseUrl}/payments/purchases/validate-promo-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_code: code,
        price_id: requestedPriceId,
        quantity: requestedQuantity,
        promo_codes: codeNames,
      }),
    });
    const result = await readResponseJson(response);
    if (
      promoValidateGenerationRef.current !== generation
      || selectedPriceIdRef.current !== requestedPriceId
      || quantityNumberRef.current !== requestedQuantity
    ) {
      return;
    }
    if (!response.ok) {
      throw result ?? new Error(promoCodeErrorMessage(result));
    }
    if (typeof result !== "object" || result === null || !("net_amount" in result) || typeof result.net_amount !== "string") {
      throw result ?? new Error(promoCodeErrorMessage(result));
    }
    setAppliedPromoCodeNames(
      "applied_code_names" in result && Array.isArray(result.applied_code_names)
        ? result.applied_code_names.filter((name): name is string => typeof name === "string")
        : codeNames,
    );
    setPromoNetCents(moneyAmountToStripeUnits(result.net_amount as MoneyAmount, USD_CURRENCY));
    if ("recurring_amount" in result && typeof result.recurring_amount === "string") {
      setPromoRecurringCents(moneyAmountToStripeUnits(result.recurring_amount as MoneyAmount, USD_CURRENCY));
    } else {
      setPromoRecurringCents(moneyAmountToStripeUnits(result.net_amount as MoneyAmount, USD_CURRENCY));
    }
    setPromoSubmitError(null);
  }, [code, selectedPriceId, quantityNumber]);

  const handleApplyPromo = useCallback(async (codeName: string) => {
    await validatePromoCodes([...appliedPromoCodeNames, codeName]);
  }, [appliedPromoCodeNames, validatePromoCodes]);

  const handleRemovePromo = useCallback(async (codeName: string) => {
    const next = appliedPromoCodeNames.filter((name) => name !== codeName);
    if (next.length === 0) {
      promoValidateGenerationRef.current += 1;
      setAppliedPromoCodeNames([]);
      setPromoNetCents(null);
      setPromoRecurringCents(null);
      setPromoSubmitError(null);
      return;
    }
    setPromoValidationInFlight(true);
    try {
      await validatePromoCodes(next);
    } catch (error) {
      setPromoSubmitError(promoCodeErrorMessage(error));
      setAppliedPromoCodeNames([]);
      setPromoNetCents(null);
      setPromoRecurringCents(null);
    } finally {
      setPromoValidationInFlight(false);
    }
  }, [appliedPromoCodeNames, validatePromoCodes]);

  const elementsMode = useMemo<"subscription" | "payment" | "setup">(() => {
    if (!selectedPriceId || !data?.product?.prices) return "subscription";
    if (appliesFreeTrialAtCheckout) return "setup";
    if (promoNetCents === 0 && appliedPromoCodeNames.length > 0) {
      const price = data.product.prices[selectedPriceId];
      if (price.interval && !isFreePrice(price.USD)) return "setup";
    }
    const price = data.product.prices[selectedPriceId];
    return price.interval ? "subscription" : "payment";
  }, [data, selectedPriceId, appliesFreeTrialAtCheckout, promoNetCents, appliedPromoCodeNames.length]);

  const validateCode = useCallback(async (baseUrl: string) => {
    const response = await fetch(`${baseUrl}/payments/purchases/validate-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        full_code: code,
        return_url: returnUrl ?? undefined,
      }),
    });
    if (!response.ok) {
      throw new Error("Failed to validate code");
    }
    const result = await response.json();
    setData(result);
    if (result?.product?.prices) {
      const priceIds = Object.keys(result.product.prices);
      if (priceIds.length > 0) {
        setSelectedPriceId(priceIds[0]);
      }
    }
  }, [code, returnUrl]);

  useEffect(() => {
    let baseUrl: string;
    try {
      baseUrl = getApiBaseUrl();
    } catch (err) {
      setConfigError(err);
      return;
    }
    setLoading(true);
    validateCode(baseUrl).catch((err) => {
      setError(err instanceof Error ? err.message : "An error occurred");
    }).finally(() => {
      setLoading(false);
    });
  }, [validateCode]);

  useEffect(() => {
    if (appliedPromoCodeNames.length === 0 || selectedPriceId == null) return;
    let cancelled = false;
    setPromoValidationInFlight(true);
    validatePromoCodes(appliedPromoCodeNames).catch((error) => {
      if (cancelled) return;
      if (
        selectedPriceIdRef.current !== selectedPriceId
        || quantityNumberRef.current !== quantityNumber
      ) {
        return;
      }
      setPromoSubmitError(promoCodeErrorMessage(error));
      setAppliedPromoCodeNames([]);
      setPromoNetCents(null);
      setPromoRecurringCents(null);
    }).finally(() => {
      if (!cancelled) {
        setPromoValidationInFlight(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // Re-validate from catalog price when the customer changes price or quantity.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only price/quantity should retrigger
  }, [selectedPriceId, quantityNumber]);

  const isFreeSelected = useMemo<boolean>(() => {
    if (!selectedPriceId || !data?.product?.prices) return false;
    const usd = data.product.prices[selectedPriceId].USD;
    return isFreePrice(usd);
  }, [data, selectedPriceId]);

  const selectedPriceData = useMemo(() => {
    if (!selectedPriceId || !data?.product?.prices) return null;
    return data.product.prices[selectedPriceId];
  }, [data, selectedPriceId]);

  const appliesPromoZeroFirstInvoice = useMemo(() => {
    if (isFreeSelected) return false;
    if (selectedPriceData?.interval == null) return false;
    return promoNetCents === 0 && appliedPromoCodeNames.length > 0;
  }, [isFreeSelected, selectedPriceData, promoNetCents, appliedPromoCodeNames.length]);

  // One-time 100% off is granted immediately with no Stripe intent. Recurring
  // $0 still needs a card (SetupIntent) because later invoices will charge.
  const appliesPromoZeroOneTime = useMemo(() => {
    if (isFreeSelected) return false;
    if (selectedPriceData?.interval != null) return false;
    return promoNetCents === 0 && appliedPromoCodeNames.length > 0;
  }, [isFreeSelected, selectedPriceData, promoNetCents, appliedPromoCodeNames.length]);

  const treatsAsFreeCheckout = isFreeSelected || appliesPromoZeroOneTime;
  const usesSetupMode = appliesFreeTrialAtCheckout || appliesPromoZeroFirstInvoice;

  const setupSubscription = async () => {
    const baseUrl = getApiBaseUrl();
    const response = await fetch(`${baseUrl}/payments/purchases/purchase-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_code: code, price_id: selectedPriceId, quantity: quantityNumber, promo_codes: appliedPromoCodeNames }),
    });
    const result = await readResponseJson(response);

    if (!response.ok) {
      const message = getPurchaseFailureMessage(result, GENERIC_PURCHASE_FAILURE_MESSAGE);
      setPromoSubmitError(message);
      throw new Error(message);
    }
    setPromoSubmitError(null);

    const clientSecret = getClientSecret(result);
    if (!clientSecret && !treatsAsFreeCheckout) {
      throw new Error(GENERIC_PURCHASE_FAILURE_MESSAGE);
    }
    if (!clientSecret) {
      return null;
    }
    return {
      clientSecret,
      stripeIntentType: getStripeIntentType(result),
    };
  };

  const handleBypass = useCallback(async () => {
    if (quantityNumber < 1 || isTooLarge) {
      return;
    }
    const baseUrl = getApiBaseUrl();
    const response = await fetch(`${baseUrl}/internal/payments/test-mode-purchase-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_code: code,
        price_id: selectedPriceId,
        quantity: quantityNumber,
        promo_codes: appliedPromoCodeNames,
      }),
    });
    if (!response.ok) {
      const result = await readResponseJson(response);
      throw new Error(getPurchaseFailureMessage(result, GENERIC_TEST_MODE_PURCHASE_FAILURE_MESSAGE));
    }
    const url = new URL(`/purchase/return`, window.location.origin);
    url.searchParams.set("bypass", "1");
    url.searchParams.set("purchase_full_code", code);
    if (returnUrl) {
      url.searchParams.set("return_url", returnUrl);
    }
    window.location.assign(url.toString());
  }, [code, selectedPriceId, quantityNumber, isTooLarge, returnUrl, appliedPromoCodeNames]);

  if (configError != null) {
    // Surface deployment/config errors to the error boundary instead of swallowing them
    // into the "Invalid Purchase Code" card. (configError is only ever set client-side.)
    throw configError;
  }

  const checkoutDisabled = quantityNumber < 1 || isTooLarge || data?.already_bought_non_stackable === true || promoValidationInFlight;
  const showInvalidPurchaseCode = !loading && error != null;

  if (showInvalidPurchaseCode) {
    return (
      <div data-hexclave-purchase-page className="relative flex min-h-screen items-center justify-center bg-white px-6 dark:bg-zinc-950">
        <div className="w-full max-w-md text-center">
          <DesignCard glassmorphic contentClassName="flex flex-col items-center gap-4 p-8">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <XCircleIcon className="size-6 text-destructive" weight="fill" />
            </div>
            <div className="space-y-2">
              <Typography type="h2" className="mb-2 text-xl font-semibold text-foreground">
                Invalid Purchase Code
              </Typography>
              <Typography type="p" variant="secondary" className="text-sm">
                The purchase code is invalid or has expired. Please check your link and try again.
              </Typography>
            </div>
          </DesignCard>
        </div>
      </div>
    );
  }

  return (
    <div data-hexclave-purchase-page className="relative min-h-screen bg-white dark:bg-zinc-950">
      <div className="relative flex min-h-screen w-full flex-col lg:flex-row">
        {/* Left Panel: Product & Pricing Selection */}
        <div className="flex flex-1 flex-col border-b border-border/40 bg-white dark:bg-zinc-950 lg:w-1/2 lg:border-b-0 lg:border-r">
          <div className="mx-auto w-full max-w-md px-6 pb-12 pt-16 lg:pt-20">
            {loading ? (
              <div className="space-y-5">
                <Skeleton className="size-12 rounded-full" />
                <Skeleton className="mt-4 h-10 w-2/3" />
                <Skeleton className="mt-2 h-5 w-full" />
                <Skeleton className="mt-8 h-20 w-full rounded-xl" />
                <Skeleton className="mt-4 h-24 w-full rounded-xl" />
              </div>
            ) : (
              <div className="space-y-8">
                {/* Product Logo */}
                {data?.project_logo_url && (
                  <div>
                    <Image
                      src={data.project_logo_url}
                      alt="Project logo"
                      className="size-12 rounded-full border border-border/40 bg-white p-1 object-contain shadow-sm dark:bg-zinc-950"
                      width={48}
                      height={48}
                      unoptimized
                    />
                  </div>
                )}

                {/* Product Name */}
                <Typography type="h1" className="text-3xl font-bold tracking-tight text-foreground">
                  {data?.product?.display_name || "Choose Your Plan"}
                </Typography>

                {/* Prominent Selected Price Display */}
                {selectedPriceData && (
                  <div className="py-2">
                    {promoNetCents != null && appliedPromoCodeNames.length > 0 ? (
                      <div className="space-y-1">
                        {(() => {
                          const firstCharge = (promoNetCents / 100).toFixed(2);
                          const recurringCents = promoRecurringCents ?? promoNetCents;
                          const recurring = (recurringCents / 100).toFixed(2);
                          const intervalLabel = selectedPriceData.interval
                            ? `/${shortenedInterval(selectedPriceData.interval)}`
                            : "";
                          const recurringDiffers = recurringCents !== promoNetCents;
                          return (
                            <>
                              <div className="flex items-baseline gap-2">
                                <span className="text-2xl font-semibold tabular-nums tracking-tight text-red-500 line-through">
                                  ${(catalogAmountCents / 100).toFixed(2)}
                                </span>
                                <span className="text-5xl font-bold tabular-nums tracking-tight text-foreground">
                                  ${firstCharge}
                                </span>
                                {selectedPriceData.interval && !recurringDiffers && (
                                  <span className="text-lg font-medium text-muted-foreground">
                                    {intervalLabel}
                                  </span>
                                )}
                                {recurringDiffers && (
                                  <span className="text-lg font-medium text-muted-foreground">
                                    first charge
                                  </span>
                                )}
                              </div>
                              {appliesFreeTrialAtCheckout && (
                                <p className="text-sm text-muted-foreground">
                                  $0.00 due now, then ${firstCharge}
                                  {recurringDiffers
                                    ? ` after your trial, then $${recurring}${intervalLabel}`
                                    : `${intervalLabel}`}
                                  {" "}with {appliedPromoCodeNames.join(", ")}
                                </p>
                              )}
                              {!appliesFreeTrialAtCheckout && recurringDiffers && (
                                <p className="text-sm text-muted-foreground">
                                  ${firstCharge} today, then ${recurring}{intervalLabel} with {appliedPromoCodeNames.join(", ")}
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="text-5xl font-bold tabular-nums tracking-tight text-foreground">
                          ${selectedPriceData.USD ?? "0.00"}
                        </span>
                        {selectedPriceData.interval && (
                          <span className="text-lg font-medium text-muted-foreground">
                            /{shortenedInterval(selectedPriceData.interval)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Conflict / Already Purchased Alerts */}
                {(data?.already_bought_non_stackable || (data?.conflicting_products && data.conflicting_products.length > 0)) && (
                  <div className="space-y-2">
                    {data.already_bought_non_stackable && (
                      <DesignAlert
                        variant="error"
                        title="Already Purchased"
                        description="You already have this product and cannot purchase it again."
                      />
                    )}
                    {data.conflicting_products && data.conflicting_products.length > 0 && (
                      <DesignAlert
                        variant="warning"
                        title="Plan Change Detected"
                        description={
                          data.conflicting_products.length === 1
                            ? `This purchase will replace your current plan: ${data.conflicting_products[0].display_name}`
                            : "This purchase will replace one of your existing plans."
                        }
                      />
                    )}
                  </div>
                )}

                {/* Pricing Options */}
                {data?.product?.prices && typedEntries(data.product.prices).length > 0 && (
                  <div className="space-y-3">
                    <Typography type="label" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Select a Pricing Option
                    </Typography>
                    <div className="grid gap-2.5">
                      {typedEntries(data.product.prices).map(([priceId, priceData]) => (
                        <PurchasePriceOption
                          key={priceId}
                          priceId={priceId}
                          priceData={priceData}
                          selected={selectedPriceId === priceId}
                          onSelect={setSelectedPriceId}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Stackable Quantity Selector */}
                {data?.product?.stackable && selectedPriceId && (
                  <div className="rounded-xl border border-border/40 bg-foreground/[0.01] p-4 sm:p-5">
                    <PurchaseQuantitySelector
                      quantityInput={quantityInput}
                      quantityNumber={quantityNumber}
                      onQuantityChange={setQuantityInput}
                      isTooLarge={isTooLarge}
                      selectedPriceId={selectedPriceId}
                      priceData={data.product.prices[selectedPriceId]}
                    />
                  </div>
                )}

                {data?.allow_promo_codes === true && selectedPriceId && (
                  <PromoCodeApplyField
                    appliedCodeNames={appliedPromoCodeNames}
                    allowStacking={data.allow_stacking_promo_codes === true}
                    disabled={checkoutDisabled}
                    onApply={handleApplyPromo}
                    onRemove={handleRemovePromo}
                  />
                )}
                {promoSubmitError != null && (
                  <DesignAlert variant="error" description={promoSubmitError} />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Checkout Form / Payment Details */}
        <div className="flex flex-1 flex-col justify-center bg-zinc-200 dark:bg-black lg:w-1/2">
          <div className="mx-auto w-full max-w-md px-6 py-12">
            {loading ? (
              <div className="space-y-4">
                <Skeleton className="h-64 w-full rounded-2xl" />
              </div>
            ) : data ? (
              <div className="space-y-4">
                {data.test_mode ? (
                  <TestModeBypassForm
                    onBypass={handleBypass}
                    disabled={checkoutDisabled}
                    ignoresFreeTrial={hasSelectedFreeTrial}
                  />
                ) : data.stripe_account_id == null ? (
                  <PaymentsNotEnabledCard />
                ) : (
                  <StripeElementsProvider
                    stripeAccountId={data.stripe_account_id}
                    amount={elementsAmountCents}
                    mode={elementsMode}
                  >
                    <CheckoutForm
                      fullCode={code}
                      stripeAccountId={data.stripe_account_id}
                      setupSubscription={setupSubscription}
                      returnUrl={returnUrl ?? undefined}
                      disabled={checkoutDisabled}
                      chargesEnabled={data.charges_enabled ?? false}
                      isFree={treatsAsFreeCheckout}
                      setupMode={usesSetupMode}
                    />
                  </StripeElementsProvider>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
