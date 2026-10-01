import { inlineProductSchema } from "@hexclave/shared/dist/schema-fields";
import * as yup from "yup";
import { AsyncStoreProperty } from "../common";

export type InlineProduct = yup.InferType<typeof inlineProductSchema>;

export type Item = {
  displayName: string,
  /**
   * May be negative.
   */
  quantity: number,
  /**
   * Equal to Math.max(0, quantity).
   */
  nonNegativeQuantity: number,
};

export type ServerItem = Item & {
  increaseQuantity(amount: number): Promise<void>,
  /**
   * Decreases the quantity by the given amount.
   *
   * Note that you may want to use tryDecreaseQuantity instead, as it will prevent the quantity from going below 0 in a race-condition-free way.
   */
  decreaseQuantity(amount: number): Promise<void>,
  /**
   * Decreases the quantity by the given amount and returns true if the result is non-negative; returns false and does nothing if the result would be negative.
   *
   * Most useful for pre-paid credits.
   */
  tryDecreaseQuantity(amount: number): Promise<boolean>,
};

export type CustomerProduct = {
  id: string | null,
  quantity: number,
  displayName: string,
  customerType: "user" | "team" | "custom",
  isServerOnly: boolean,
  stackable: boolean,
  /** @deprecated Product ownership is independent of purchase type. Will be removed in a future version. */
  type?: "one_time" | "subscription",
  subscription: null | {
    subscriptionId: string | null,
    currentPeriodEnd: Date | null,
    cancelAtPeriodEnd: boolean,
    isCancelable: boolean,
  },
  switchOptions?: Array<{
    productId: string,
    displayName: string,
    prices: InlineProduct["prices"],
  }>,
};

export type CustomerProductsList = CustomerProduct[] & {
  nextCursor: string | null,
};

export type CustomerProductsListOptions = {
  cursor?: string,
  limit?: number,
};

export type CustomerProductsRequestOptions =
  | ({ userId: string } & CustomerProductsListOptions)
  | ({ teamId: string } & CustomerProductsListOptions)
  | ({ customCustomerId: string } & CustomerProductsListOptions);

export type CustomerInvoiceStatus = "draft" | "open" | "paid" | "uncollectible" | "void" | null;

export type CustomerInvoice = {
  createdAt: Date,
  status: CustomerInvoiceStatus,
  amountTotal: number,
  hostedInvoiceUrl: string | null,
};

export type CustomerInvoicesList = CustomerInvoice[] & {
  nextCursor: string | null,
};

export type CustomerInvoicesListOptions = {
  cursor?: string,
  limit?: number,
};

export type CustomerInvoicesRequestOptions =
  | ({ userId: string } & CustomerInvoicesListOptions)
  | ({ teamId: string } & CustomerInvoicesListOptions);

export type CustomerDefaultPaymentMethod = {
  id: string,
  brand: string | null,
  last4: string | null,
  exp_month: number | null,
  exp_year: number | null,
} | null;

export type CustomerBilling = {
  hasCustomer: boolean,
  defaultPaymentMethod: CustomerDefaultPaymentMethod,
};

export type CustomerPaymentMethodSetupIntent = {
  clientSecret: string,
  stripeAccountId: string,
};

export type Customer<IsServer extends boolean = false> =
  & {
    readonly id: string,

    createCheckoutUrl(options: (
      | { productId: string, returnUrl?: string, allowPromoCodes?: boolean, allowStackingPromoCodes?: boolean }
      | (IsServer extends true ? { product: InlineProduct, returnUrl?: string, allowPromoCodes?: boolean, allowStackingPromoCodes?: boolean } : never)
    )): Promise<string>,

    createPaymentMethodSetupIntent(): Promise<CustomerPaymentMethodSetupIntent>,

    setDefaultPaymentMethodFromSetupIntent(setupIntentId: string): Promise<CustomerDefaultPaymentMethod>,

    switchSubscription(options: {
      fromProductId: string,
      toProductId: string,
      priceId?: string,
      quantity?: number,
      promoCodes?: string[],
    }): Promise<void>,

    validatePromoCodes(options: {
      productId: string,
      priceId?: string,
      quantity?: number,
      promoCodes: string[],
    }): Promise<{ originalAmount: string, netAmount: string, recurringAmount: string, appliedCodeNames: string[] }>,
  }
  & AsyncStoreProperty<
    "billing",
    [],
    CustomerBilling,
    false
  >
  & AsyncStoreProperty<
    "item",
    [itemId: string],
    IsServer extends true ? ServerItem : Item,
    false
  >
  & AsyncStoreProperty<
    "products",
    [options?: CustomerProductsListOptions],
    CustomerProductsList,
    true
  >
  & AsyncStoreProperty<
    "invoices",
    [options?: CustomerInvoicesListOptions],
    CustomerInvoicesList,
    true
  >
  & (IsServer extends true ? {
    grantProduct(
      product: { productId: string, quantity?: number } | { product: InlineProduct, quantity?: number },
    ): Promise<void>,
  } : {});
