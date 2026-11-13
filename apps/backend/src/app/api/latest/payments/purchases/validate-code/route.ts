import { SubscriptionStatus } from "@/generated/prisma/client";
import { productToInlineProduct } from "@/lib/payments";
import { getOwnedProductsForCustomer } from "@/lib/payments/customer-data";
import type { ProductSnapshot } from "@/lib/payments/schema/types";
import { validateRedirectUrl } from "@/lib/redirect-urls";
import { getTenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { inlineProductSchema, urlSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import { purchaseUrlVerificationCodeHandler } from "../verification-code-handler";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Validate Purchase Code",
    description: "Validates a purchase verification code and returns purchase details including available prices.",
    tags: ["Payments"],
  },
  request: yupObject({
    body: yupObject({
      full_code: yupString().defined().meta({
        openapiField: {
          description: "The verification code, given as a query parameter in the purchase URL",
          exampleValue: "proj_abc123_def456ghi789"
        }
      }),
      return_url: urlSchema.optional().meta({
        openapiField: {
          description: "URL to redirect to after purchase completion",
          exampleValue: "https://myapp.com/purchase-success"
        }
      }),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      product: inlineProductSchema,
      stripe_account_id: yupString().nullable().defined(),
      project_id: yupString().defined(),
      project_logo_url: yupString().nullable().defined(),
      already_bought_non_stackable: yupBoolean().defined(),
      conflicting_products: yupArray(yupObject({
        product_id: yupString().defined(),
        display_name: yupString().defined(),
      }).defined()).defined(),
      // True when purchase-session will in-place update an existing Stripe subscription
      // (no new trial_period_days). Checkout must not mount Elements in setup mode then.
      replaces_stripe_subscription: yupBoolean().defined().meta({
        openapiField: {
          description: "Whether this purchase will replace an existing Stripe-backed subscription in-place (free trials are not re-applied on that path)",
          exampleValue: false,
        },
      }),
      test_mode: yupBoolean().defined(),
      charges_enabled: yupBoolean().nullable().defined(),
      allow_promo_codes: yupBoolean().defined(),
      allow_stacking_promo_codes: yupBoolean().defined(),
    }).defined(),
  }),
  async handler({ body }) {
    const verificationCode = await purchaseUrlVerificationCodeHandler.validateCode(body.full_code);
    const tenancy = await getTenancy(verificationCode.data.tenancyId);
    if (!tenancy) {
      throw new HexclaveAssertionError(`No tenancy found for given tenancyId`);
    }
    if (body.return_url && !validateRedirectUrl(body.return_url, tenancy)) {
      throw new KnownErrors.RedirectUrlNotWhitelisted(body.return_url);
    }
    const product = verificationCode.data.product;

    // Compute purchase context info from Bulldozer owned products
    const prisma = await getPrismaClientForTenancy(tenancy);
    const ownedProducts = await getOwnedProductsForCustomer({
      prisma,
      tenancyId: tenancy.id,
      customerType: product.customerType,
      customerId: verificationCode.data.customerId,
    });

    const alreadyBoughtNonStackable = !!(
      verificationCode.data.productId
      && verificationCode.data.productId in ownedProducts
      && ownedProducts[verificationCode.data.productId].quantity > 0
      && product.stackable !== true
    );

    const productLines = tenancy.config.payments.productLines;
    const productLineId = Object.keys(productLines).find((g) => product.productLineId === g);
    let conflictingProductLineProducts: { product_id: string, display_name: string }[] = [];
    const addOnBaseProductIds = product.isAddOnTo ? new Set(Object.keys(product.isAddOnTo)) : new Set<string>();
    if (productLineId) {
      const isSubscribable = Object.values(product.prices).some((p) => p.interval != null);
      if (isSubscribable) {
        conflictingProductLineProducts = Object.entries(ownedProducts)
          .filter(([productId, p]) => p.productLineId === productLineId && p.quantity > 0 && !addOnBaseProductIds.has(productId))
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([productId, p]) => ({
            product_id: productId,
            display_name: p.product.displayName ?? productId,
          }));
      }
    }

    // Mirror purchase-session: only Stripe-backed same-line subs are updated in-place
    // (and therefore skip trial_period_days). Test-mode / DB-only conflicts are canceled
    // then a new sub is created, which can still start a trial.
    let replacesStripeSubscription = false;
    if (productLineId != null && conflictingProductLineProducts.length > 0) {
      const activeStripeSubs = await prisma.subscription.findMany({
        where: {
          tenancyId: tenancy.id,
          customerType: typedToUppercase(product.customerType),
          customerId: verificationCode.data.customerId,
          status: { in: [SubscriptionStatus.active, SubscriptionStatus.trialing] },
          stripeSubscriptionId: { not: null },
        },
        select: { productId: true, product: true },
      });
      replacesStripeSubscription = activeStripeSubs.some((s) =>
        (s.product as ProductSnapshot).productLineId === productLineId
        && !addOnBaseProductIds.has(s.productId ?? "")
      );
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        product: productToInlineProduct(product, {
          productId: verificationCode.data.productId ?? null,
          customerType: product.customerType,
          customerId: verificationCode.data.customerId,
        }),
        stripe_account_id: verificationCode.data.stripeAccountId ?? null,
        project_id: tenancy.project.id,
        project_logo_url: tenancy.project.logo_url ?? null,
        already_bought_non_stackable: alreadyBoughtNonStackable,
        conflicting_products: conflictingProductLineProducts,
        replaces_stripe_subscription: replacesStripeSubscription,
        test_mode: tenancy.config.payments.testMode === true,
        charges_enabled: verificationCode.data.chargesEnabled ?? null,
        allow_promo_codes: verificationCode.data.allowPromoCodes === true,
        allow_stacking_promo_codes: verificationCode.data.allowPromoCodes === true && verificationCode.data.allowStackingPromoCodes === true,
      },
    };
  },
});


export const GET = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    query: yupObject({
      full_code: yupString().defined(),
      return_url: urlSchema.optional(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      valid: yupBoolean().defined(),
    }).defined(),
  }),
  async handler({ query }) {
    const tenancyId = query.full_code.split("_")[0];
    if (!tenancyId) {
      throw new KnownErrors.VerificationCodeNotFound();
    }
    const tenancy = await getTenancy(tenancyId);
    if (!tenancy) {
      throw new KnownErrors.VerificationCodeNotFound();
    }
    if (query.return_url && !validateRedirectUrl(query.return_url, tenancy)) {
      throw new KnownErrors.RedirectUrlNotWhitelisted(query.return_url);
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        valid: true,
      },
    };
  },
});
