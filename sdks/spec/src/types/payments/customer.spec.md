# Customer

Interface for payment and billing operations. Implemented by CurrentUser and Team.


## Properties

id: string
  The customer identifier (user ID or team ID).


## Methods


### createCheckoutUrl(options)

options.productId: string - ID of the product to purchase
options.returnUrl: string? - URL to redirect after checkout
options.allowPromoCodes: bool? - default false; purchase page shows a promo-code field. Fails with PROMO_CODES_DISABLED if payments.allowPromoCodes is off.
options.allowStackingPromoCodes: bool? - default false; requires allowPromoCodes. Fails with PROMO_CODE_STACKING_DISABLED if payments.allowStackingPromoCodes is off.

Returns: string (checkout URL)

POST /api/v1/payments/purchases/create-purchase-url { product_id, return_url, allow_promo_codes, allow_stacking_promo_codes } [authenticated]
Route: apps/backend/src/app/api/latest/payments/purchases/create-purchase-url/route.ts

Returns a checkout URL for purchasing the product. Typed promo names are entered on the purchase page, not passed here.

Errors: PROMO_CODES_DISABLED, PROMO_CODE_STACKING_DISABLED.


### getBilling()

Returns: CustomerBilling

GET /api/v1/customers/{type}/{id}/billing [authenticated]
Route: apps/backend/src/app/api/latest/customers/[...]/billing/route.ts

CustomerBilling has:
  hasCustomer: bool - whether a Stripe customer exists
  defaultPaymentMethod: CustomerDefaultPaymentMethod | null

CustomerDefaultPaymentMethod has:
  id: string
  brand: string | null (e.g., "visa", "mastercard")
  last4: string | null
  exp_month: number | null
  exp_year: number | null

Does not error.


### createPaymentMethodSetupIntent()

Returns: CustomerPaymentMethodSetupIntent

POST /api/v1/customers/{type}/{id}/payment-method-setup-intent [authenticated]

CustomerPaymentMethodSetupIntent has:
  clientSecret: string - for Stripe.js to confirm setup
  stripeAccountId: string - the connected Stripe account

Does not error.


### setDefaultPaymentMethodFromSetupIntent(setupIntentId)

setupIntentId: string

Returns: CustomerDefaultPaymentMethod

POST /api/v1/customers/{type}/{id}/default-payment-method { setup_intent_id } [authenticated]

After user completes payment method setup via Stripe.js,
call this to set it as default.

Does not error.


### getItem(itemId)

itemId: string

Returns: Item

GET /api/v1/customers/{type}/{id}/items/{itemId} [authenticated]

Item has:
  displayName: string
  quantity: number - may be negative
  nonNegativeQuantity: number - Math.max(0, quantity)

Does not error.


### listItems()

Returns: Item[]

GET /api/v1/customers/{type}/{id}/items [authenticated]

Does not error.


### hasItem(itemId)

itemId: string

Returns: bool

Check if getItem(itemId).quantity > 0.

Does not error.


### getItemQuantity(itemId)

itemId: string

Returns: number

Get getItem(itemId).quantity.

Does not error.


### listProducts(options?)

options.cursor: string?
options.limit: number?

Returns: CustomerProductsList

GET /api/v1/customers/{type}/{id}/products [authenticated]
Route: apps/backend/src/app/api/latest/customers/[...]/products/route.ts

CustomerProductsList is CustomerProduct[] with:
  nextCursor: string | null

Does not error.


### switchSubscription(options)

options.fromProductId: string - current subscription product ID
options.toProductId: string - target subscription product ID
options.priceId: string? - specific price of target product
options.quantity: number?
options.promoCodes: string[]? - codes to apply on this switch. Empty/omitted means no codes. Project config payments.allowPromoCodes must be true to apply any; payments.allowStackingPromoCodes must be true to apply more than one.

POST /api/v1/payments/products/{type}/{id}/switch { from_product_id, to_product_id, price_id, quantity, promo_codes } [authenticated]

For switching between subscription plans.

Errors: PROMO_CODES_DISABLED, PROMO_CODE_STACKING_DISABLED, and other promo KnownErrors.


### validatePromoCodes(options)

Available on client and server Customer objects (CurrentUser, Team).

options.productId: string
options.priceId: string?
options.quantity: number?
options.promoCodes: string[]

Returns: { originalAmount: string, netAmount: string, recurringAmount: string, appliedCodeNames: string[] }

netAmount is the first charge (including first-payment-only codes). recurringAmount is later renewals (forever / fixed-duration codes only).

POST /api/v1/payments/products/{type}/{id}/validate-promo-codes { product_id, price_id, quantity, promo_codes } [authenticated]
Route: apps/backend/src/app/api/latest/payments/products/[customer_type]/[customer_id]/validate-promo-codes/route.ts

Validates typed promo names against a product without redeeming them. Stacking is controlled by project configuration.

HexclaveServerApp also has a server-only validatePromoCodes that POSTs /api/v1/payments/promo-codes/validate with a server key.

Errors: PROMO_CODES_DISABLED, PROMO_CODE_STACKING_DISABLED, and other promo KnownErrors.


---

# CustomerProduct

A product associated with a customer.


## Properties

id: string | null
  Product ID, or null for inline products.

quantity: number
  Quantity owned.

displayName: string
  Product display name.

customerType: "user" | "team" | "custom"
  Type of customer this product is for.

isServerOnly: bool
  Whether this product can only be granted server-side.

stackable: bool
  Whether multiple quantities can be owned.

type: "one_time" | "subscription"
  Product type.

subscription: SubscriptionInfo | null
  Subscription details if type is "subscription".

switchOptions: SwitchOption[]?
  Available products to switch to (for subscriptions).


## SubscriptionInfo

currentPeriodEnd: Date | null
  When current billing period ends.

cancelAtPeriodEnd: bool
  Whether subscription will cancel at period end.

isCancelable: bool
  Whether subscription can be canceled.


## SwitchOption

productId: string
displayName: string
prices: Price[]


---

# Price

A price point for a product.


## Properties

id: string
  Unique price identifier.

amount: number
  Price amount in the smallest currency unit (e.g., cents for USD).

currency: string
  Three-letter currency code (e.g., "usd", "eur").

interval: "month" | "year" | null
  Billing interval for subscriptions, or null for one-time purchases.

intervalCount: number | null
  Number of intervals between billings (e.g., 1 for monthly, 3 for quarterly).


---

# ServerItem (server-only)

Server-side item with modification methods.

Extends: Item


## Methods


### increaseQuantity(amount)

amount: number (positive)

POST /api/v1/customers/{type}/{id}/items/{itemId}/quantity { change: amount } [server-only]

Does not error.


### decreaseQuantity(amount)

amount: number (positive)

POST /api/v1/customers/{type}/{id}/items/{itemId}/quantity { change: -amount } [server-only]

Note: Quantity may go negative. Use tryDecreaseQuantity for atomic decrement-if-positive.

Does not error.


### tryDecreaseQuantity(amount)

amount: number (positive)

Returns: bool

POST /api/v1/customers/{type}/{id}/items/{itemId}/try-decrease { amount } [server-only]

Returns true if quantity was >= amount and was decreased.
Returns false if quantity would go negative (no change made).

Useful for pre-paid credits to prevent overdraft.

Does not error.


---

# InlineProduct

For creating products on-the-fly without pre-defining them.


## Properties

displayName: string
type: "one_time" | "subscription"
isServerOnly: bool?
stackable: bool?
prices: InlinePrice[]


## InlinePrice

amount: number (in cents)
currency: string (e.g., "usd")
interval: "month" | "year"? (for subscriptions)
